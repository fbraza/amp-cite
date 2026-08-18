import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import ampCitePlugin, { description } from "../index.ts"
import { fetchEuropePmcFulltext, normalizeEuropePmcIdentifier } from "../lib/europe-pmc.ts"
import { searchLiterature } from "../lib/literature-search.ts"
import { searchPubmed } from "../lib/pubmed.ts"
import { dedupeKeys, doiToUrl, normalizePmcid, pmcidToUrl } from "../lib/shared.ts"
import type { PaperRecord } from "../lib/types.ts"
import {
	buildZoteroOwnershipIndex,
	markPapersWithZoteroOwnership,
	searchZotero,
	zoteroItemToPaperRecord,
} from "../lib/zotero.ts"

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

function europePmcSearchResult(overrides: Record<string, unknown> = {}) {
	return {
		hitCount: 1,
		resultList: {
			result: [
				{
					source: "MED",
					id: "12345",
					pmid: "12345",
					pmcid: "PMC555",
					doi: "10.1000/example",
					title: "Open paper",
					authorString: "Smith J",
					journalTitle: "Test Journal",
					pubYear: "2024",
					isOpenAccess: "Y",
					license: "CC BY",
					...overrides,
				},
			],
		},
	}
}

const nestedJats = `<article>
	<front><article-meta><title-group><article-title>Open paper</article-title></title-group><fn-group><fn><p>SECRET FRONT FOOTNOTE</p></fn></fn-group></article-meta></front>
	<body>
		<sec><title>Introduction</title><p>Introductory <italic>context</italic>.</p></sec>
		<sec><title>Materials and Methods</title><p>Methods body.</p>
			<fig><caption><p>SECRET FIGURE CAPTION</p></caption></fig>
			<table-wrap><caption><p>SECRET TABLE TEXT</p></caption><table><tr><td>SECRET CELL</td></tr></table></table-wrap>
			<supplementary-material><p>SECRET SUPPLEMENT</p></supplementary-material>
			<sec><title>Cohort selection</title><p>Nested method detail.</p></sec>
		</sec>
		<sec><title>Results and Discussion</title><p>Combined scientific findings and interpretation.</p></sec>
		<ref-list><title>References</title><ref><mixed-citation>SECRET REFERENCE</mixed-citation></ref></ref-list>
	</body>
</article>`

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
		["literature_search", "pubmed_search", "zotero_search", "europe_pmc_fulltext"],
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
	const skill = await readFile(new URL("../skills/researching-literature/SKILL.md", import.meta.url), "utf8")
	assert.match(skill, /^name: researching-literature$/m)
	for (const tool of ["literature_search", "pubmed_search", "zotero_search", "europe_pmc_fulltext"]) {
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

test("Europe PMC identifier normalization accepts only canonical DOI, PMID, and PMCID forms", () => {
	assert.deepEqual(normalizeEuropePmcIdentifier("https://doi.org/10.1000/Example"), {
		type: "doi",
		normalized: "10.1000/example",
		query: "DOI:10.1000/example",
	})
	assert.equal(normalizeEuropePmcIdentifier("DOI: 10.1000/example").normalized, "10.1000/example")
	assert.deepEqual(normalizeEuropePmcIdentifier("PMID: 12345"), {
		type: "pmid",
		normalized: "12345",
		query: "EXT_ID:12345 AND SRC:MED",
	})
	assert.deepEqual(normalizeEuropePmcIdentifier("PMCID: pmc555"), {
		type: "pmcid",
		normalized: "PMC555",
		query: "PMCID:PMC555",
	})
	assert.throws(() => normalizeEuropePmcIdentifier("555abc"), /Malformed identifier/)
	assert.throws(() => normalizeEuropePmcIdentifier("PMCID:555"), /Malformed identifier/)
})

test("Europe PMC requires an exact unambiguous match", async () => {
	let calls = 0
	globalThis.fetch = async () => {
		calls++
		return new Response(JSON.stringify(europePmcSearchResult({ doi: "10.1000/different" })), {
			headers: { "content-type": "application/json" },
		})
	}
	const notFound = await fetchEuropePmcFulltext({ identifier: "10.1000/example" })
	assert.equal(notFound.status, "unavailable")
	assert.equal(notFound.reason, "not_found")
	assert.equal(notFound.recommended_fallback, "pubmed_abstract")
	assert.equal(calls, 1)

	globalThis.fetch = async () => {
		const payload = europePmcSearchResult()
		payload.resultList.result.push({ ...payload.resultList.result[0] })
		return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } })
	}
	const ambiguous = await fetchEuropePmcFulltext({ identifier: "10.1000/example" })
	assert.equal(ambiguous.status, "unavailable")
	assert.equal(ambiguous.reason, "ambiguous_match")
})

test("Europe PMC OA success extracts nested JATS sections and excludes non-body content", async () => {
	const calls: string[] = []
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input)
		calls.push(url)
		assert.equal(init?.method, "GET")
		if (url.includes("/search?")) {
			const parsed = new URL(url)
			assert.equal(parsed.searchParams.get("query"), "EXT_ID:12345 AND SRC:MED")
			assert.equal(parsed.searchParams.get("resultType"), "core")
			assert.equal(parsed.searchParams.get("format"), "json")
			assert.equal(parsed.searchParams.get("pageSize"), "5")
			return new Response(JSON.stringify(europePmcSearchResult()), { headers: { "content-type": "application/json" } })
		}
		assert.match(url, /\/PMC555\/fullTextXML$/)
		return new Response(nestedJats, { headers: { "content-type": "application/xml" } })
	}

	const result = await fetchEuropePmcFulltext({ identifier: "PMID:12345", sections: ["methods", "discussion"] })
	assert.equal(result.status, "full_text")
	if (result.status !== "full_text") return
	assert.equal(result.metadata.license, "CC BY")
	assert.equal(result.metadata.pmid, "12345")
	assert.equal(result.sections.length, 3)
	assert.deepEqual(result.sections.map((section) => section.heading), ["Materials and Methods", "Cohort selection", "Results and Discussion"])
	assert.equal(result.sections[1]?.section, "methods")
	assert.equal(result.sections[2]?.section, "discussion")
	const output = JSON.stringify(result)
	for (const excluded of ["SECRET FRONT", "SECRET FIGURE", "SECRET TABLE", "SECRET CELL", "SECRET SUPPLEMENT", "SECRET REFERENCE"]) {
		assert.doesNotMatch(output, new RegExp(excluded))
	}
	assert.match(output, /Nested method detail/)
	assert.deepEqual(result.missing_sections, [])
	assert.equal(calls.length, 2)
})

test("Europe PMC never requests XML for non-OA or OA records without a PMCID", async () => {
	for (const [record, reason] of [
		[{ isOpenAccess: "N" }, "not_open_access"],
		[{ pmcid: undefined }, "no_pmcid"],
	] as const) {
		let calls = 0
		globalThis.fetch = async () => {
			calls++
			return new Response(JSON.stringify(europePmcSearchResult(record)), { headers: { "content-type": "application/json" } })
		}
		const result = await fetchEuropePmcFulltext({ identifier: "10.1000/example" })
		assert.equal(result.status, "unavailable")
		assert.equal(result.reason, reason)
		assert.equal(calls, 1)
	}
})

test("Europe PMC maps missing XML and oversized sources to unavailable results", async () => {
	for (const [xmlResponse, reason] of [
		[new Response("missing", { status: 404 }), "xml_not_available"],
		[new Response("too large", { headers: { "content-length": String(5 * 1024 * 1024 + 1) } }), "source_too_large"],
	] as const) {
		let calls = 0
		globalThis.fetch = async () => {
			calls++
			if (calls === 1) return new Response(JSON.stringify(europePmcSearchResult()), { headers: { "content-type": "application/json" } })
			return xmlResponse
		}
		const result = await fetchEuropePmcFulltext({ identifier: "PMC555" })
		assert.equal(result.status, "unavailable")
		assert.equal(result.reason, reason)
	}
})

test("Europe PMC reports provider and malformed JATS failures", async () => {
	globalThis.fetch = async () => new Response("rate limited", { status: 429 })
	await assert.rejects(fetchEuropePmcFulltext({ identifier: "PMC555" }), /rate limited \(HTTP 429\)/)

	let calls = 0
	globalThis.fetch = async () => {
		calls++
		if (calls === 1) return new Response(JSON.stringify(europePmcSearchResult()), { headers: { "content-type": "application/json" } })
		return new Response("<article><body><sec>", { headers: { "content-type": "application/xml" } })
	}
	await assert.rejects(fetchEuropePmcFulltext({ identifier: "PMC555" }), /unclosed <sec> tag/)
})

test("Europe PMC falls back to unclassified body sections only for default section selection", async () => {
	const unclassifiedJats = "<article><body><sec><title>Overview</title><p>Readable body text.</p></sec></body></article>"
	globalThis.fetch = async (input: RequestInfo | URL) =>
		String(input).includes("/search?")
			? new Response(JSON.stringify(europePmcSearchResult()), { headers: { "content-type": "application/json" } })
			: new Response(unclassifiedJats, { headers: { "content-type": "application/xml" } })

	const defaultResult = await fetchEuropePmcFulltext({ identifier: "PMC555" })
	assert.equal(defaultResult.status, "full_text")
	if (defaultResult.status !== "full_text") return
	assert.equal(defaultResult.section_fallback, true)
	assert.equal(defaultResult.sections[0]?.section, "other")

	const explicitResult = await fetchEuropePmcFulltext({ identifier: "PMC555", sections: ["results"] })
	assert.equal(explicitResult.status, "full_text")
	if (explicitResult.status !== "full_text") return
	assert.equal(explicitResult.section_fallback, false)
	assert.deepEqual(explicitResult.sections, [])
	assert.deepEqual(explicitResult.missing_sections, ["results"])
})

test("Europe PMC enforces excerpt caps, reports truncation, and executes as JSON", async () => {
	globalThis.fetch = async (input: RequestInfo | URL) =>
		String(input).includes("/search?")
			? new Response(JSON.stringify(europePmcSearchResult()), { headers: { "content-type": "application/json" } })
			: new Response(nestedJats, { headers: { "content-type": "application/xml" } })

	const capped = await fetchEuropePmcFulltext({ identifier: "PMC555", sections: ["all"], max_chars: 20 })
	assert.equal(capped.status, "full_text")
	if (capped.status !== "full_text") return
	assert.equal(capped.returned_chars, 20)
	assert.equal(capped.truncated, true)
	assert.equal(capped.sections[0]?.truncated, true)
	assert.equal(capped.sections.length, 4)
	assert.throws(() => normalizeEuropePmcIdentifier("not an id"), /Malformed identifier/)

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
	const output = await tools.find((tool) => tool.name === "europe_pmc_fulltext")!.execute({ identifier: "PMC555", sections: ["results"] })
	const parsed = JSON.parse(output)
	assert.equal(parsed.tool, "europe_pmc_fulltext")
	assert.equal(parsed.status, "full_text")
})

test.afterEach(() => {
	globalThis.fetch = originalFetch
	setEnv("NCBI_API_KEY", originalNcbiApiKey)
	setEnv("ZOTERO_API_KEY", originalZoteroApiKey)
	setEnv("ZOTERO_USER_ID", originalZoteroUserId)
	setEnv("ZOTERO_LIBRARY", originalZoteroLibrary)
	setEnv("ZOTERO_GROUP_ID", originalZoteroGroupId)
})
