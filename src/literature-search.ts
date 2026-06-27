import { searchPubmed } from "./pubmed.ts"
import { booleanParam, dedupeKeys, integerParam, normalizeDoi, stringArrayParam, stringParam, unique } from "./shared.ts"
import type { PaperRecord, ProviderExecution, SearchEvent, SearchSummary } from "./types.ts"
import {
	getZoteroApiKey,
	markPapersWithZoteroOwnership,
	prepareZoteroOwnership,
	ZOTERO_DEFAULT_INDEX_CAP,
} from "./zotero.ts"

export type LiteratureSearchParams = {
	pubmed_query: string
	max_results?: number
	date_from?: string
	date_to?: string
	publication_types?: string[]
	fetch_abstracts?: boolean
}

export type LiteratureSearchResult = {
	tool: "literature_search"
	count: number
	papers: PaperRecord[]
	providers: {
		pubmed: ProviderExecution
		zotero?: ProviderExecution
	}
	searches: SearchSummary[]
	events: SearchEvent[]
}

export function parseLiteratureInput(input: Record<string, unknown>): LiteratureSearchParams {
	return {
		pubmed_query: stringParam(input, "pubmed_query", true)!,
		max_results: integerParam(input, "max_results", 20, 1, 200),
		date_from: stringParam(input, "date_from"),
		date_to: stringParam(input, "date_to"),
		publication_types: stringArrayParam(input, "publication_types"),
		fetch_abstracts: booleanParam(input, "fetch_abstracts"),
	}
}

function sourceList(paper: PaperRecord): string[] {
	return unique([...(paper.sources ?? []), ...(paper.source ? paper.source.split(";") : [])].map((source) => source.trim()).filter(Boolean))
}

function mergePapers(existing: PaperRecord, incoming: PaperRecord): PaperRecord {
	const sources = unique([...sourceList(existing), ...sourceList(incoming)])
	return {
		...incoming,
		...existing,
		doi: normalizeDoi(existing.doi) ?? normalizeDoi(incoming.doi),
		pmid: existing.pmid ?? incoming.pmid,
		pmcid: existing.pmcid ?? incoming.pmcid,
		title: existing.title !== "Untitled" ? existing.title : incoming.title,
		abstract: existing.abstract ?? incoming.abstract,
		authors: unique([...(existing.authors ?? []), ...(incoming.authors ?? [])]),
		journal: existing.journal ?? incoming.journal,
		year: existing.year ?? incoming.year,
		publication_types: unique([...(existing.publication_types ?? []), ...(incoming.publication_types ?? [])]),
		mesh_terms: unique([...(existing.mesh_terms ?? []), ...(incoming.mesh_terms ?? [])]),
		source: sources.join(";"),
		sources,
	}
}

export function dedupeLiteraturePapers(papers: PaperRecord[]): PaperRecord[] {
	const merged: PaperRecord[] = []
	const keyToIndex = new Map<string, number>()

	for (const paper of papers) {
		const keys = dedupeKeys(paper)
		const existingIndex = keys.map((key) => keyToIndex.get(key)).find((index) => index !== undefined)

		if (existingIndex === undefined) {
			const index = merged.length
			const sources = sourceList(paper)
			merged.push({ ...paper, source: sources.join(";"), sources })
			for (const key of keys) keyToIndex.set(key, index)
			continue
		}

		merged[existingIndex] = mergePapers(merged[existingIndex], paper)
		for (const key of dedupeKeys(merged[existingIndex])) keyToIndex.set(key, existingIndex)
	}

	return merged
}

export async function searchLiterature(params: LiteratureSearchParams, signal?: AbortSignal): Promise<LiteratureSearchResult> {
	const maxResults = Math.min(200, Math.max(1, Math.floor(params.max_results ?? 20)))
	const events: SearchEvent[] = [{ phase: "start" }]
	const searches: SearchSummary[] = []

	events.push({ phase: "query_start", provider: "pubmed", query_index: 1, query: params.pubmed_query })
	const pubmed = await searchPubmed(
		{
			query: params.pubmed_query,
			max_results: maxResults,
			date_from: params.date_from,
			date_to: params.date_to,
			publication_types: params.publication_types,
			fetch_abstracts: params.fetch_abstracts,
		},
		signal,
	)

	searches.push({ provider: "pubmed", query_index: 1, query: pubmed.query ?? params.pubmed_query, count: pubmed.count })
	events.push({ phase: "query_results", provider: "pubmed", query_index: 1, query: pubmed.query ?? params.pubmed_query, count: pubmed.count })
	events.push({ phase: "dedupe" })

	let papers = dedupeLiteraturePapers(pubmed.papers)
	const providers: LiteratureSearchResult["providers"] = {
		pubmed: {
			searched: true,
			count: pubmed.count,
			query: pubmed.query ?? params.pubmed_query,
			total: pubmed.total,
		},
	}

	const zoteroApiKey = getZoteroApiKey()
	if (zoteroApiKey && papers.length > 0) {
		try {
			events.push({ phase: "zotero_start" })
			const ownership = await prepareZoteroOwnership({
				apiKey: zoteroApiKey,
				cap: ZOTERO_DEFAULT_INDEX_CAP,
				signal,
				onProgress: ({ items, total }) => {
					events.push({ phase: "zotero_progress", library_items: items, total })
				},
			})
			const marked = markPapersWithZoteroOwnership(papers, ownership.index)
			const matched = marked.filter((paper) => paper.in_zotero).length
			papers = marked
			providers.zotero = {
				searched: true,
				count: ownership.libraryItems,
				query: "ownership scan",
				total: ownership.total,
			}
			events.push({
				phase: "zotero_results",
				library_items: ownership.libraryItems,
				matched,
				total_candidates: papers.length,
			})
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			providers.zotero = { searched: false, reason: message }
			events.push({ phase: "query_error", provider: "zotero", query_index: 0, query: "ownership scan", error: message })
		}
	} else if (zoteroApiKey) {
		providers.zotero = { searched: false, reason: "No PubMed candidates to check" }
	}

	events.push({ phase: "complete", count: papers.length })
	return { tool: "literature_search", count: papers.length, papers, providers, searches, events }
}
