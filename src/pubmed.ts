import type { PaperRecord } from "./types.ts"
import {
	booleanParam,
	enumParam,
	fetchJson,
	fetchText,
	integerParam,
	normalizeDoi,
	normalizePmcid,
	pickAll,
	pickOne,
	sleep,
	stringArrayParam,
	stringParam,
	unique,
	xmlDecode,
} from "./shared.ts"

export const DEFAULT_NCBI_API_KEY_ENV = "NCBI_API_KEY"

export type PubmedSort = "relevance" | "pub_date" | "first_author"

export type PubmedSearchParams = {
	query: string
	max_results?: number
	date_from?: string
	date_to?: string
	publication_types?: string[]
	fetch_abstracts?: boolean
	sort?: PubmedSort
	api_key?: string
}

export type PubmedSearchResult = {
	tool: "pubmed_search"
	count: number
	papers: PaperRecord[]
	query?: string
	total?: number
	events: Array<{ phase: string; message?: string; count?: number }>
}

export function parsePubmedInput(input: Record<string, unknown>): PubmedSearchParams {
	return {
		query: stringParam(input, "query", true)!,
		max_results: integerParam(input, "max_results", 20, 1, 200),
		date_from: stringParam(input, "date_from"),
		date_to: stringParam(input, "date_to"),
		publication_types: stringArrayParam(input, "publication_types"),
		fetch_abstracts: booleanParam(input, "fetch_abstracts"),
		sort: enumParam(input, "sort", ["relevance", "pub_date", "first_author"]),
		api_key: stringParam(input, "api_key"),
	}
}

export function getNcbiApiKey(envVarName?: string): string | undefined {
	const keyEnv = envVarName?.trim() || DEFAULT_NCBI_API_KEY_ENV
	const apiKey = process.env[keyEnv]?.trim()
	return apiKey || undefined
}

export function addNcbiApiKeyParam(url: URL, envVarName?: string): boolean {
	const apiKey = getNcbiApiKey(envVarName)
	if (!apiKey) return false
	url.searchParams.set("api_key", apiKey)
	return true
}

export function normalizePubmedQuery(
	query: string,
	publicationTypes?: string[],
	dateFrom?: string,
	dateTo?: string,
): string {
	const fragments = [query.trim()].filter(Boolean)
	if (publicationTypes && publicationTypes.length > 0) {
		fragments.push(`(${publicationTypes.map((item) => `"${item}"[Publication Type]`).join(" OR ")})`)
	}
	if (dateFrom || dateTo) {
		const start = dateFrom ?? "1000/01/01"
		const end = dateTo ?? "3000/12/31"
		fragments.push(`(${start}:${end}[Date - Publication])`)
	}
	return fragments.join(" AND ")
}

export function parsePubmedArticle(articleXml: string): PaperRecord {
	const pmid = pickOne(/<PMID[^>]*>(.*?)<\/PMID>/i, articleXml)
	const title = pickOne(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/i, articleXml) ?? "Untitled"
	const abstractSections = pickAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/gi, articleXml)
	const abstract = abstractSections.join(" ").trim() || undefined
	const journal = pickOne(/<Title>([\s\S]*?)<\/Title>/i, articleXml) ?? pickOne(/<ISOAbbreviation>(.*?)<\/ISOAbbreviation>/i, articleXml)
	const yearText =
		pickOne(/<PubDate>[\s\S]*?<Year>(\d{4})<\/Year>/i, articleXml) ??
		pickOne(/<ArticleDate[^>]*>[\s\S]*?<Year>(\d{4})<\/Year>/i, articleXml) ??
		pickOne(/<PubMedPubDate[^>]*PubStatus="pubmed">[\s\S]*?<Year>(\d{4})<\/Year>/i, articleXml)
	const doi =
		normalizeDoi(pickOne(/<ELocationID[^>]*EIdType="doi"[^>]*>(.*?)<\/ELocationID>/i, articleXml)) ??
		normalizeDoi(pickOne(/<ArticleId[^>]*IdType="doi"[^>]*>(.*?)<\/ArticleId>/i, articleXml))
	const pmcid = normalizePmcid(
		pickOne(/<ArticleId[^>]*IdType="pmc"[^>]*>(.*?)<\/ArticleId>/i, articleXml) ??
			pickOne(/<ArticleId[^>]*IdType="pmcid"[^>]*>(.*?)<\/ArticleId>/i, articleXml),
	)
	const publicationTypes = unique(pickAll(/<PublicationType[^>]*>([\s\S]*?)<\/PublicationType>/gi, articleXml))
	const meshTerms = unique(pickAll(/<DescriptorName[^>]*>([\s\S]*?)<\/DescriptorName>/gi, articleXml))
	const authors = unique(
		Array.from(
			articleXml.matchAll(
				/<Author[\s\S]*?<LastName>(.*?)<\/LastName>[\s\S]*?(?:<ForeName>(.*?)<\/ForeName>|<Initials>(.*?)<\/Initials>)/gi,
			),
		).map((match) => {
			const last = xmlDecode(match[1] ?? "")
			const fore = xmlDecode(match[2] ?? match[3] ?? "")
			return [fore, last].filter(Boolean).join(" ").trim()
		}),
	)
	const collectiveAuthors = pickAll(/<CollectiveName>([\s\S]*?)<\/CollectiveName>/gi, articleXml)
	return {
		pmid,
		pmcid,
		doi,
		title,
		abstract,
		authors: unique([...authors, ...collectiveAuthors]),
		journal,
		year: yearText ? Number(yearText) : undefined,
		publication_types: publicationTypes,
		mesh_terms: meshTerms,
		source: "pubmed",
	}
}

export function parsePubmedArticles(xml: string): PaperRecord[] {
	const chunks = xml.match(/<PubmedArticle>[\s\S]*?<\/PubmedArticle>/gi) ?? []
	return chunks.map(parsePubmedArticle)
}

export async function searchPubmed(params: PubmedSearchParams, signal?: AbortSignal): Promise<PubmedSearchResult> {
	const maxResults = Math.min(200, Math.max(1, Math.floor(params.max_results ?? 20)))
	const query = normalizePubmedQuery(params.query, params.publication_types, params.date_from, params.date_to)
	const events: PubmedSearchResult["events"] = [{ phase: "search", message: `Searching PubMed for: ${params.query}` }]

	const esearchUrl = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi")
	esearchUrl.searchParams.set("db", "pubmed")
	esearchUrl.searchParams.set("retmode", "json")
	esearchUrl.searchParams.set("retmax", String(maxResults))
	esearchUrl.searchParams.set("sort", params.sort ?? "relevance")
	esearchUrl.searchParams.set("term", query)
	const hasApiKey = addNcbiApiKeyParam(esearchUrl, params.api_key)

	const esearch = await fetchJson<{ esearchresult?: { idlist?: string[]; count?: string } }>(esearchUrl.toString(), signal)
	const ids = esearch.esearchresult?.idlist ?? []
	if (ids.length === 0) {
		return { tool: "pubmed_search", count: 0, papers: [], query, total: Number(esearch.esearchresult?.count ?? 0), events }
	}

	if (params.fetch_abstracts === false) {
		const papers = ids.map((pmid) => ({ pmid, title: "PubMed record", source: "pubmed" }))
		events.push({ phase: "complete", count: papers.length })
		return { tool: "pubmed_search", count: papers.length, papers, query, total: Number(esearch.esearchresult?.count ?? papers.length), events }
	}

	const rateLimitMs = hasApiKey ? 120 : 350
	const batchSize = 50
	const papers: PaperRecord[] = []
	for (let start = 0; start < ids.length; start += batchSize) {
		const batch = ids.slice(start, start + batchSize)
		events.push({
			phase: "fetch_abstracts",
			message: `Fetching PubMed abstracts ${start + 1}-${Math.min(start + batch.length, ids.length)} of ${ids.length}`,
		})
		const efetchUrl = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi")
		efetchUrl.searchParams.set("db", "pubmed")
		efetchUrl.searchParams.set("retmode", "xml")
		efetchUrl.searchParams.set("id", batch.join(","))
		addNcbiApiKeyParam(efetchUrl, params.api_key)
		const xml = await fetchText(efetchUrl.toString(), signal)
		papers.push(...parsePubmedArticles(xml))
		if (start + batchSize < ids.length) await sleep(rateLimitMs, signal)
	}
	events.push({ phase: "complete", count: papers.length })
	return {
		tool: "pubmed_search",
		count: papers.length,
		papers,
		query,
		total: Number(esearch.esearchresult?.count ?? papers.length),
		events,
	}
}
