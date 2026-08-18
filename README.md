# amp-cite

Amp-oriented port of [`@fbraza/pi-cite`](https://github.com/fbraza/pi-cite), packaged as one self-contained Amp directory plugin:

1. **Four literature tools** for PubMed, read-only Zotero ownership checks, combined literature search, and Europe PMC open-access full-text excerpts.
2. **A bundled literature skill** that teaches the agent how to use those tools for verified citation search, paper screening, optional full-text escalation, and structured synthesis.

This repository contains the Amp port of the original Pi extension code.

## Current contents

```text
amp-cite/
├── index.ts
├── lib/
│   ├── europe-pmc.ts
│   ├── literature-search.ts
│   ├── pubmed.ts
│   ├── shared.ts
│   ├── types.ts
│   └── zotero.ts
├── skills/researching-literature/
│   ├── SKILL.md
│   ├── references/
│   │   ├── preclinical-extraction-guide.md
│   │   ├── pubmed_api_reference.md
│   │   ├── pubmed_common_queries.md
│   │   ├── pubmed_routine.md
│   │   └── pubmed_search_syntax.md
│   └── scripts/
│       ├── export_all.py
│       ├── extract_experiments.py
│       ├── generate_table.py
│       └── synthesis.py
└── tests/
    ├── amp-cite.test.ts
    └── literature-output.test.ts
```

The plugin explicitly registers its bundled skill with `amp.registerSkill`. Amp exposes it under the qualified name `amp-cite:researching-literature`; there is no separate bare project skill. The skill's `builtin-tools` frontmatter gates all four plugin tools until the skill is loaded.

## Amp plugin tools

The Amp plugin preserves the original tool names because the skill is written around them:

- `literature_search` — PubMed search plus optional read-only Zotero ownership annotation.
- `pubmed_search` — direct PubMed E-utilities search and metadata retrieval.
- `zotero_search` — read-only Zotero library search.
- `europe_pmc_fulltext` — resolves one DOI, PMID, or PMCID and returns bounded structured excerpts when Europe PMC has open-access JATS; otherwise recommends the PubMed abstract fallback.

The standard workflow searches PubMed with full abstracts and uses Zotero only to annotate whether papers are already owned. Broad reviews use 2–4 focused PubMed-ready queries whose results are merged and deduplicated. Full text is opt-in: the skill escalates a small pivotal set to Europe PMC, records OA provenance and fallback reasons, and never writes to Zotero. Default reports retain their existing Paper Summary Table; reports requested with full text append an explicit `Evidence Source` column.

## Environment variables

The environment variables are inherited from `pi-cite`:

| Variable | Purpose |
|---|---|
| `NCBI_API_KEY` | Optional PubMed / NCBI E-utilities API key for higher rate limits. |
| `ZOTERO_API_KEY` | Enables read-only Zotero lookup and ownership checks. |
| `ZOTERO_USER_ID` | Optional user ID override when Zotero key introspection is insufficient. |
| `ZOTERO_LIBRARY` | `user` by default; set to `group` for group libraries. |
| `ZOTERO_GROUP_ID` | Required only when `ZOTERO_LIBRARY=group`. |

## Use in Amp

The repository root is the complete Amp directory plugin package. To publish it through a User or Workspace Plugins repository, copy the repository contents into that plugin repository as an `amp-cite/` directory. Keeping the directory intact preserves the implementation, bundled skill, references, and scripts.

The source repository deliberately does not place the package under `.amp/plugins/`. The `.amp/` directory is ignored so repository-local Amp configuration can remain unversioned.

After installing or publishing the plugin and reloading plugins, inspect the bundled skill with:

```bash
amp skill info amp-cite:researching-literature
```

The plugin tools return JSON strings containing paper records, provider metadata, and event summaries. Unit tests mock PubMed, Europe PMC, and Zotero network calls; live API checks should be done manually with small result and excerpt bounds.

## Develop

```bash
npm test
npm run pack:check
```

The optional preclinical extraction script uses only the Python standard library; pandas is not required.

## Porting status

- [x] Repository scaffold created.
- [x] Literature skill, references, and scripts bundled into the directory plugin.
- [x] Skill registered as `amp-cite:researching-literature` with gated plugin tools.
- [x] PubMed/Zotero TypeScript logic ported from Pi extension to Amp plugin API.
- [x] Europe PMC open-access full-text retrieval added with bounded JATS excerpts.
- [x] Amp plugin tests added.
- [x] README updated with final install and usage instructions.

## Upstream provenance

This project is derived from `@fbraza/pi-cite` version `0.4.0`, which was built for the Pi coding agent. The upstream package used Pi-specific extension metadata, tool registration, rendering, and packaging. This port keeps the PubMed/Zotero behavior and skill resources while replacing the Pi extension adapter with Amp's project plugin API.
