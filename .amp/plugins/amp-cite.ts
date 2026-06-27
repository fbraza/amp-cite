import { parseLiteratureInput, searchLiterature } from "../../src/literature-search.ts"
import { parsePubmedInput, searchPubmed } from "../../src/pubmed.ts"
import { parseZoteroInput, searchZotero } from "../../src/zotero.ts"

type PluginAPI = {
	logger?: { log: (...args: unknown[]) => void }
	registerTool: (definition: PluginToolDefinition) => unknown
}

type PluginToolDefinition = {
	name: string
	description: string
	inputSchema: {
		type: "object"
		properties?: Record<string, object>
		required?: string[]
		[key: string]: unknown
	}
	execute: (input: Record<string, unknown>, ctx?: unknown) => Promise<string>
}

function jsonResult(value: unknown): string {
	return JSON.stringify(value, null, 2)
}

const pubmedInputSchema = {
	type: "object" as const,
	properties: {
		query: { type: "string", description: "PubMed query string, including field tags such as [tiab], [mh], or [pt] when appropriate." },
		max_results: { type: "number", description: "Maximum results to return. Default 20, maximum 200." },
		date_from: { type: "string", description: "Publication start date as YYYY/MM/DD." },
		date_to: { type: "string", description: "Publication end date as YYYY/MM/DD." },
		publication_types: { type: "array", items: { type: "string" }, description: "PubMed publication types to combine with OR." },
		fetch_abstracts: { type: "boolean", description: "Whether to fetch abstracts and full metadata. Default true." },
		sort: { type: "string", enum: ["relevance", "pub_date", "first_author"], description: "PubMed sort order. Default relevance." },
		api_key: { type: "string", description: "Environment variable name containing an NCBI API key. Defaults to NCBI_API_KEY." },
	},
	required: ["query"],
}

const literatureInputSchema = {
	type: "object" as const,
	properties: {
		pubmed_query: { type: "string", description: "PubMed-ready query using MeSH [mh], title/abstract [tiab], publication type [pt], substance [nm], and Boolean logic." },
		max_results: { type: "number", description: "Maximum PubMed results to return. Default 20, maximum 200." },
		date_from: { type: "string", description: "PubMed publication start date as YYYY/MM/DD." },
		date_to: { type: "string", description: "PubMed publication end date as YYYY/MM/DD." },
		publication_types: { type: "array", items: { type: "string" }, description: "PubMed publication types to combine with OR." },
		fetch_abstracts: { type: "boolean", description: "Whether PubMed should fetch abstracts and full metadata. Default true." },
	},
	required: ["pubmed_query"],
}

const zoteroInputSchema = {
	type: "object" as const,
	properties: {
		query: { type: "string", description: "Quick-search query for the Zotero library." },
		max_results: { type: "number", description: "Maximum results to return. Default 25, maximum 100." },
		qmode: { type: "string", enum: ["everything", "titleCreatorYear"], description: "Zotero quick-search mode. Default everything." },
		item_type: { type: "string", description: "Optional Zotero item type filter, e.g. journalArticle." },
		api_key: { type: "string", description: "Environment variable name containing a Zotero API key. Defaults to ZOTERO_API_KEY." },
	},
	required: ["query"],
}

export default function ampCitePlugin(amp: PluginAPI) {
	amp.registerTool({
		name: "literature_search",
		description:
			"Run a literature workflow search against PubMed using a PubMed-ready query. If ZOTERO_API_KEY is set, read-only Zotero ownership flags are added to PubMed candidates.",
		inputSchema: literatureInputSchema,
		async execute(input) {
			return jsonResult(await searchLiterature(parseLiteratureInput(input)))
		},
	})

	amp.registerTool({
		name: "pubmed_search",
		description: "Search PubMed with typed parameters and return paper metadata, including abstracts when requested.",
		inputSchema: pubmedInputSchema,
		async execute(input) {
			return jsonResult(await searchPubmed(parsePubmedInput(input)))
		},
	})

	amp.registerTool({
		name: "zotero_search",
		description: "Search a Zotero library read-only by keyword and return metadata for papers already in the library.",
		inputSchema: zoteroInputSchema,
		async execute(input) {
			return jsonResult(await searchZotero(parseZoteroInput(input)))
		},
	})

	amp.logger?.log?.("amp-cite plugin registered literature_search, pubmed_search, and zotero_search")
}
