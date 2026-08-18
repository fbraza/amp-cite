# amp-cite

Amp-oriented port of [`@fbraza/pi-cite`](https://github.com/fbraza/pi-cite), packaged as one self-contained Amp directory plugin:

1. **Literature tools** for PubMed, Zotero, and combined literature search.
2. **A bundled literature skill** that teaches the agent how to use those tools for verified citation search, paper screening, and structured synthesis.

This repository contains the Amp port of the original Pi extension code.

## Current contents

```text
.amp/plugins/amp-cite/
├── index.ts
├── lib/
│   ├── literature-search.ts
│   ├── pubmed.ts
│   ├── shared.ts
│   ├── types.ts
│   └── zotero.ts
└── skills/researching-literature/
    ├── SKILL.md
    ├── references/
    │   ├── preclinical-extraction-guide.md
    │   ├── pubmed_api_reference.md
    │   ├── pubmed_common_queries.md
    │   ├── pubmed_routine.md
    │   └── pubmed_search_syntax.md
    └── scripts/
        ├── export_all.py
        ├── extract_experiments.py
        ├── generate_table.py
        └── synthesis.py
tests/
└── amp-cite.test.ts
```

The plugin explicitly registers its bundled skill with `amp.registerSkill`. Amp exposes it under the qualified name `amp-cite:researching-literature`; there is no separate bare project skill. The skill's `builtin-tools` frontmatter gates all three plugin tools until the skill is loaded.

## Amp plugin tools

The Amp plugin preserves the original tool names because the skill is written around them:

- `literature_search` — PubMed search plus optional read-only Zotero ownership annotation.
- `pubmed_search` — direct PubMed E-utilities search and metadata retrieval.
- `zotero_search` — read-only Zotero library search.

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

This repository is arranged as an Amp workspace plugin. Open this repository as the active Amp workspace, then reload plugins from Amp's command palette with:

```text
plugins: reload
```

Amp discovers the project plugin at:

```text
.amp/plugins/amp-cite/index.ts
```

If you want the plugin in another project, copy the complete `.amp/plugins/amp-cite/` directory. Keeping the directory intact preserves the implementation, bundled skill, references, and scripts.

After reloading, inspect the bundled skill and its resources with:

```bash
amp skill info amp-cite:researching-literature
```

The plugin tools return JSON strings containing paper records, provider metadata, and event summaries. Unit tests mock all PubMed/Zotero network calls; live API checks should be done manually with small `max_results` values.

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
- [x] Amp plugin tests added.
- [x] README updated with final install and usage instructions.

## Upstream provenance

This project is derived from `@fbraza/pi-cite` version `0.4.0`, which was built for the Pi coding agent. The upstream package used Pi-specific extension metadata, tool registration, rendering, and packaging. This port keeps the PubMed/Zotero behavior and skill resources while replacing the Pi extension adapter with Amp's project plugin API.
