export type PaperRecord = {
	pmid?: string
	pmcid?: string
	doi?: string
	title: string
	abstract?: string
	authors?: string[]
	journal?: string
	year?: number
	publication_types?: string[]
	mesh_terms?: string[]
	source?: string
	sources?: string[]
	date?: string
	category?: string
	version?: string
	license?: string
	in_zotero?: boolean
	zotero_key?: string
}

export type SearchEvent = {
	phase: string
	provider?: string
	query_index?: number
	query?: string
	count?: number
	total?: number
	library_items?: number
	matched?: number
	total_candidates?: number
	error?: string
}

export type ProviderExecution =
	| { searched: true; count: number; query: string; total?: number }
	| { searched: false; reason: string }

export type SearchSummary = {
	provider: string
	query_index: number
	query: string
	count: number
}
