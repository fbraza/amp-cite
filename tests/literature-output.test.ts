import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

const script = String.raw`
import json
import sys

sys.path.insert(0, "skills/researching-literature/scripts")
from generate_table import build_table_rows

paper = {
    "pmid": "12345",
    "doi": "10.1000/example",
    "title": "Example paper",
    "abstract": "Example abstract.",
    "authors": ["Smith J"],
    "year": "2024",
}

scenario = sys.argv[1]
if scenario == "default":
    general = build_table_rows([paper])
    preclinical = build_table_rows([paper], mode="preclinical")
    print(json.dumps({"general": list(general[0]), "preclinical": list(preclinical[0])}))
elif scenario == "full_text":
    paper["evidence_source"] = "Europe PMC OA full-text excerpt"
    rows = build_table_rows([paper], full_text_requested=True)
    print(json.dumps({"headers": list(rows[0]), "source": rows[0]["Evidence Source"]}))
elif scenario == "missing_provenance":
    build_table_rows([paper], full_text_requested=True)
`

function runPython(scenario: string) {
	return spawnSync("python3", ["-c", script, scenario], {
		cwd: process.cwd(),
		encoding: "utf8",
		env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
	})
}

const generalHeaders = [
	"#",
	"PMID/DOI",
	"In Zotero",
	"Authors (year)",
	"Key Message",
	"Key Results",
	"Key Methods",
	"Study Type",
	"Evidence Quality",
	"DOI",
	"Access Link",
]

test("literature table default headers remain exactly backward compatible", () => {
	const result = runPython("default")
	assert.equal(result.status, 0, result.stderr)
	const headers = JSON.parse(result.stdout)
	assert.deepEqual(headers.general, generalHeaders)
	assert.deepEqual(headers.preclinical, [
		...generalHeaders.slice(0, -2),
		"Experiment Type",
		"Model System",
		"Assay/Endpoint",
		"Finding Direction",
		"DOI",
		"Access Link",
	])
})

test("full-text opt-in appends explicit evidence provenance", () => {
	const result = runPython("full_text")
	assert.equal(result.status, 0, result.stderr)
	const output = JSON.parse(result.stdout)
	assert.deepEqual(output.headers, [...generalHeaders, "Evidence Source"])
	assert.equal(output.source, "Europe PMC OA full-text excerpt")
})

test("full-text opt-in fails clearly when evidence provenance is missing", () => {
	const result = runPython("missing_provenance")
	assert.notEqual(result.status, 0)
	assert.match(result.stderr, /Evidence provenance is required for PMID:12345/)
	assert.match(result.stderr, /set evidence_source explicitly for every paper/)
})
