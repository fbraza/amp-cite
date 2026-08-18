import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import ampCitePlugin, { description } from "../.amp/plugins/amp-cite/index.ts"
import { searchLiterature } from "../.amp/plugins/amp-cite/lib/literature-search.ts"
import { searchPubmed } from "../.amp/plugins/amp-cite/lib/pubmed.ts"
import { dedupeKeys, doiToUrl, normalizePmcid, pmcidToUrl } from "../.amp/plugins/amp-cite/lib/shared.ts"
import type { PaperRecord } from "../.amp/plugins/amp-cite/lib/types.ts"
import {
	buildZoteroOwnershipIndex,
	markPapersWithZoteroOwnership,
	searchZotero,
	zoteroItemToPaperRecord,
} from "../.amp/plugins/amp-cite/lib/zotero.ts"

const originalFetch = globalThis.fetch
const originalNcbiApiKey = process.env.NCBI_API_KEY
const originalZoteroApiKey = process.env.ZOTERO_API_KEY
const originalZoteroUserId = process.env.ZOTERO_USER_ID
const originalZoteroLibrary = process.env.ZOTERO_LIBRARY
const originalZoteroGroupId = process.env.ZOTERO_GROUP_ID

function setEnv(name: string, value: string | undefined) {
	if (value === undefined) delete process.env[name]
	else process.env[name] = value
}

function pubmedXml({
	pmid = "12345",
	title = "Fallback paper",
	abstract = "Fallback abstract.",
	journal = "Fallback Journal",
	year = "2024",
	doi,
}: {
	pmid?: string
	title?: string
	abstract?: string
	journal?: string
	year?: string
	doi?: string
} = {}) {
	return `<PubmedArticleSet>
		<PubmedArticle>
			<MedlineCitation>
				<PMID>${pmid}</PMID>
				<Article>
					<ArticleTitle>${title}</ArticleTitle>
					<Abstract><AbstractText>${abstract}</AbstractText></Abstract>
					<Journal><Title>${journal}</Title><JournalIssue><PubDate><Year>${year}</Year></PubDate></JournalIssue></Journal>
					${doi ? `<ELocationID EIdType="doi">${doi}</ELocationID>` : ""}
				</Article>
			</MedlineCitation>
		</PubmedArticle>
	</PubmedArticleSet>`
}

function zoteroItemFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		key: "ZOTKEY1",
		version: 1,
		library: { type: "user", id: 475425 },
		meta: { creatorSummary: "Smith", parsedDate: "2023-06-01", numChildren: 1 },
		data: {
			key: "ZOTKEY1",
			itemType: "journalArticle",
			title: "Owned paper",
			abstractNote: "Owned abstract.",
			creators: [{ creatorType: "author", firstName: "Jane", lastName: "Smith" }],
			publicationTitle: "Owned Journal",
			date: "2023-06-01",
			DOI: "10.1000/example",
			url: "https://doi.org/10.1000/example",
			extra: "PMID: 111\nPMCID: PMC555",
			tags: [],
		},
		...overrides,
	}
}

test("Amp directory plugin registers its bundled skill and expected tools", async () => {
	const tools: Array<Record<string, unknown>> = []
	const skills: Array<Record<string, unknown>> = []
	await ampCitePlugin({
		registerTool(tool: Record<string, unknown>) {
			tools.push(tool)
		},
		async registerSkill(skill: Record<string, unknown>) {
			skills.push(skill)
			return { unsubscribe() {} }
		},
		logger: { log() {} },
	} as any)

	assert.match(description, /PubMed and Zotero/)
	assert.deepEqual(skills, [{ path: "skills/researching-literature" }])
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["literature_search", "pubmed_search", "zotero_search"],
	)
	for (const tool of tools) {
		assert.equal(typeof tool.description, "string")
		assert.equal((tool.inputSchema as { type?: string }).type, "object")
		assert.equal(typeof tool.execute, "function")
		assert.equal(tool.parameters, undefined)
		assert.equal(tool.renderResult, undefined)
		assert.equal(tool.label, undefined)
	}
})

test("bundled skill has its qualified-name metadata, gated tools, and resources", async () => {
	const skill = await readFile(new URL("../.amp/plugins/amp-cite/skills/researching-literature/SKILL.md", import.meta.url), "utf8")
	assert.match(skill, /^name: researching-literature$/m)
	for (const tool of ["literature_search", "pubmed_search", "zotero_search"]) {
		assert.match(skill, new RegExp(`^  - ${tool}$`, "m"))
	}
	assert.match(skill, /references\/pubmed_routine\.md/)
	assert.match(skill, /scripts\/extract_experiments\.py/)
})

test("pubmed_search uses NCBI_API_KEY and returns JSON-ready records without abstracts", async () => {
	setEnv("NCBI_API_KEY", "test-ncbi-key")
	const calls: string[] = []
	globalThis.fetch = async (input: RequestInfo | URL) => {
		const url = String(input)
		calls.push(url)
		return new Response(JSON.stringify({ esearchresult: { idlist: ["12345"], count: "1" } }), {
			status: 200,
			headers: { "content-type": "application/json" },
		})
	}

	const result = await searchPubmed({ query: "trained immunity", max_results: 1, fetch_abstracts: false })

	assert.equal(new URL(calls[0]!).searchParams.get("api_key"), "test-ncbi-key")
	assert.equal(result.tool, "pubmed_search")
	assert.equal(result.count, 1)
	assert.equal(result.query, "trained immunity")
	assert.deepEqual(result.papers, [{ pmid: "12345", title: "PubMed record", source: "pubmed" }])
	assert.ok(result.events.some((event) => event.phase === "complete"))
})

test("literature_search searches PubMed and skips Zotero when no key is set", async () => {
	setEnv("ZOTERO_API_KEY", undefined)
	const calls: string[] = []
	globalThis.fetch = async (input: RequestInfo | URL) => {
		const url = String(input)
		calls.push(url)
		if (url.includes("esearch.fcgi")) {
			return new Response(JSON.stringify({ esearchresult: { idlist: ["12345"], count: "1" } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})
		}
		if (url.includes("efetch.fcgi")) {
			return new Response(pubmedXml(), { status: 200, headers: { "content-type": "application/xml" } })
		}
		throw new Error(`Unexpected fetch: ${url}`)
	}

	const result = await searchLiterature({ pubmed_query: "trained immunity[tiab]", max_results: 1 })

	assert.ok(calls.some((url) => url.includes("esearch.fcgi")))
	assert.ok(calls.some((url) => url.includes("efetch.fcgi")))
	assert.ok(calls.every((url) => url.includes("eutils.ncbi.nlm.nih.gov")))
	assert.equal(result.tool, "literature_search")
	assert.equal(result.count, 1)
	assert.equal(result.providers.pubmed.searched, true)
	assert.equal(result.providers.zotero, undefined)
	assert.equal(result.papers[0].title, "Fallback paper")
	assert.equal(result.papers[0].abstract, "Fallback abstract.")
	assert.deepEqual(result.papers[0].sources, ["pubmed"])
	assert.ok(result.events.some((event) => event.phase === "complete" && event.count === 1))
})

test("shared helpers normalize PMCID/DOI and build dedupe keys", () => {
	assert.equal(normalizePmcid("pmcid: PMC555"), "PMC555")
	assert.equal(normalizePmcid("PMC555"), "PMC555")
	assert.equal(normalizePmcid("555"), "PMC555")
	assert.equal(normalizePmcid(undefined), undefined)
	assert.equal(doiToUrl("10.1000/example"), "https://doi.org/10.1000/example")
	assert.equal(doiToUrl("https://doi.org/10.1000/example"), "https://doi.org/10.1000/example")
	assert.equal(doiToUrl(undefined), undefined)
	assert.equal(pmcidToUrl("PMC555"), "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC555/")
	assert.equal(pmcidToUrl(undefined), undefined)
	const keys = dedupeKeys({ title: "Owned paper", doi: "10.1000/example", pmid: "111", pmcid: "PMC555", year: 2023, source: "zotero" })
	assert.deepEqual(keys.sort(), ["doi:10.1000/example", "pmcid:PMC555", "pmid:111", "title-year:owned paper:2023"])
})

test("Zotero helpers convert records and mark owned candidates", () => {
	const paper = zoteroItemToPaperRecord(zoteroItemFixture() as any)
	assert.deepEqual(paper, {
		title: "Owned paper",
		abstract: "Owned abstract.",
		doi: "10.1000/example",
		pmid: "111",
		pmcid: "PMC555",
		authors: ["Jane Smith"],
		journal: "Owned Journal",
		year: 2023,
		source: "zotero",
		in_zotero: true,
		zotero_key: "ZOTKEY1",
	})

	const index = buildZoteroOwnershipIndex([zoteroItemFixture() as any])
	assert.equal(index.get("doi:10.1000/example"), "ZOTKEY1")
	assert.equal(index.get("pmid:111"), "ZOTKEY1")
	assert.equal(index.get("pmcid:PMC555"), "ZOTKEY1")
	assert.equal(index.get("title-year:owned paper:2023"), "ZOTKEY1")

	const candidates: PaperRecord[] = [
		{ title: "Owned paper", doi: "10.1000/example", year: 2023, source: "pubmed" },
		{ title: "New paper", doi: "10.9999/nope", year: 2024, source: "pubmed" },
	]
	const marked = markPapersWithZoteroOwnership(candidates, index)
	assert.equal(marked[0].in_zotero, true)
	assert.equal(marked[0].zotero_key, "ZOTKEY1")
	assert.equal(marked[1].in_zotero, false)
	assert.equal(marked[1].zotero_key, undefined)
})

test("zotero_search validates the key and returns owned papers", async () => {
	setEnv("ZOTERO_API_KEY", "test-zotero-key")
	setEnv("ZOTERO_USER_ID", "475425")
	const calls: string[] = []
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		assert.equal(init?.method, "GET")
		assert.equal(init?.body, undefined)
		const url = String(input)
		calls.push(url)
		if (url.includes("/keys/current")) {
			return new Response(JSON.stringify({ userID: 475425, username: "tester" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})
		}
		if (url.includes("/items/top")) {
			return new Response(JSON.stringify([zoteroItemFixture()]), {
				status: 200,
				headers: { "content-type": "application/json", "Total-Results": "1" },
			})
		}
		throw new Error(`Unexpected fetch: ${url}`)
	}

	const result = await searchZotero({ query: "trained immunity", max_results: 5 })

	assert.ok(calls.some((url) => url.includes("/keys/current")))
	assert.ok(calls.some((url) => url.includes("/items/top")))
	assert.equal(result.tool, "zotero_search")
	assert.equal(result.count, 1)
	assert.equal(result.total, 1)
	assert.equal(result.papers[0].doi, "10.1000/example")
	assert.equal(result.papers[0].in_zotero, true)
})

test("literature_search marks PubMed candidates already in Zotero", async () => {
	setEnv("ZOTERO_API_KEY", "test-zotero-key")
	setEnv("ZOTERO_USER_ID", "475425")
	globalThis.fetch = async (input: RequestInfo | URL) => {
		const url = String(input)
		if (url.includes("esearch.fcgi")) {
			return new Response(JSON.stringify({ esearchresult: { idlist: ["12345"], count: "1" } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})
		}
		if (url.includes("efetch.fcgi")) {
			return new Response(pubmedXml({ doi: "10.1000/example", title: "Owned paper", year: "2023" }), {
				status: 200,
				headers: { "content-type": "application/xml" },
			})
		}
		if (url.includes("/keys/current")) {
			return new Response(JSON.stringify({ userID: 475425, username: "tester" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})
		}
		if (url.includes("/items/top")) {
			return new Response(JSON.stringify([zoteroItemFixture()]), {
				status: 200,
				headers: { "content-type": "application/json", "Total-Results": "1" },
			})
		}
		throw new Error(`Unexpected fetch: ${url}`)
	}

	const result = await searchLiterature({ pubmed_query: "trained immunity[tiab]", max_results: 1 })

	assert.equal(result.papers.length, 1)
	assert.equal(result.papers[0].doi, "10.1000/example")
	assert.equal(result.papers[0].in_zotero, true)
	assert.equal(result.papers[0].zotero_key, "ZOTKEY1")
	assert.equal(result.providers.zotero?.searched, true)
	assert.ok(result.events.some((event) => event.phase === "zotero_results" && event.matched === 1))
})

test("registered Amp tool execute returns parseable JSON", async () => {
	setEnv("ZOTERO_API_KEY", undefined)
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ esearchresult: { idlist: ["12345"], count: "1" } }), {
			status: 200,
			headers: { "content-type": "application/json" },
		})
	const tools: Array<{ name: string; execute: (input: Record<string, unknown>) => Promise<string> }> = []
	await ampCitePlugin({
		registerTool(tool: any) {
			tools.push(tool)
		},
		async registerSkill() {
			return { unsubscribe() {} }
		},
		logger: { log() {} },
	} as any)
	const pubmed = tools.find((tool) => tool.name === "pubmed_search")!
	const output = await pubmed.execute({ query: "trained immunity", max_results: 1, fetch_abstracts: false })
	const parsed = JSON.parse(output)
	assert.equal(parsed.tool, "pubmed_search")
	assert.equal(parsed.count, 1)
})

test.afterEach(() => {
	globalThis.fetch = originalFetch
	setEnv("NCBI_API_KEY", originalNcbiApiKey)
	setEnv("ZOTERO_API_KEY", originalZoteroApiKey)
	setEnv("ZOTERO_USER_ID", originalZoteroUserId)
	setEnv("ZOTERO_LIBRARY", originalZoteroLibrary)
	setEnv("ZOTERO_GROUP_ID", originalZoteroGroupId)
})
