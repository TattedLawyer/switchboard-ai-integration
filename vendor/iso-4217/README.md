# ISO-4217 currency list — provenance

## The source is NOT in this repo

This repository ships only the **derived** artifacts: the ISO-4217 codes the pipeline
admits, rendered into a TypeScript module for the ingest door and a CSV seed for dbt.
SIX's `list-one.xml` itself is **not vendored**, and never has been in any commit reachable
from this branch.

Why: SIX publishes the table for public download but attaches **no redistribution grant or
licence** to it, and the only express term reachable from the download page is a site-wide
terms-of-use that asserts copyright in "the entire content" of the site and limits use to
"personal use as well as information purposes". Redistributing the file would have rested
on the argument that a currency table is uncopyrightable fact — defensible, and the
position several comparable projects take, but an argument rather than a permission.
Shipping only what we derive avoids needing the argument at all, and it is what most of the
ecosystem does (Debian `iso-codes`, `pycountry` and Datahub all publish derivations and
assert their own licence over them). This was the owner's decision, taken on the research
in full.

## What the artifacts were rendered from

| | |
| --- | --- |
| **Source** | SIX Group AG — the ISO 4217 Maintenance Agency, publishing on behalf of ISO and SNV |
| **File** | `list-one.xml` (current currencies and funds) |
| **URL** | `https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml` (linked from <https://www.six-group.com/en/products-services/financial-information/data-standards.html>) |
| **Published date** | `2026-01-01` — the document's own `<ISO_4217 Pblshd="…">` attribute; the amendment carrying Bulgaria's euro adoption |
| **SHA-256 of the exact bytes** | `838dfb991648cf36df939edd5fe3811737962b75a32252847d239cedd1e291c9` |
| **Size** | 47,463 bytes |
| **Fetched** | 2026-08-04, byte-for-byte as served |

**The SHA-256 is documentary, not a check.** Nothing in this repo can recompute it — that
is the direct cost of not vendoring the file, and it is stated here rather than glossed. It
exists so a maintainer refreshing the list can confirm they fetched the same bytes these
artifacts came from, and so a change of source is visible in a diff.

## The generated artifacts

| Artifact | Consumer |
| --- | --- |
| `ingest/src/iso4217-codes.ts` | the ingest door — `numeric-contract.ts`'s `currency` rule |
| `warehouse/seeds/iso_4217_currencies.csv` | dbt — the three staging models' currency guard |

Both are **generated, committed, and pinned by content**. `ingest/test/iso4217.test.ts`
holds a golden SHA-256 of each file, the exact admitted count (176) as a literal, spot
codes that must be present, and both exclusions asserted absent. Changing an artifact
therefore requires a matching, visible edit to the test — a deliberate act, never a silent
drift. The old mutual "module and seed agree" pin is retained as a cheap tripwire, but it is
explicitly **not** the oracle: with the source file gone it would pass for any mutually
consistent pair.

The generator's own logic is exercised against a **synthetic** fixture,
`ingest/test/fixtures/iso4217-synthetic.xml` — hand-authored in `list-one`'s shape with
invented codes. It is deliberately not an excerpt of the real table; a redacted copy under
another name would reintroduce exactly what this repo stopped shipping.

## Deliberate exclusions

`list-one` is "currencies **and funds**", so it publishes codes that are not currencies a
vendor can legitimately bill in:

- **`XXX`** — "the codes assigned for transactions where no currency is involved".
  Admitting it would let *"no currency"* through the door **as** a currency, and the mart
  would group and refuse sums by it as if it named a unit.
- **`XTS`** — "codes specifically reserved for testing purposes". Production data carrying
  it is a misconfigured vendor, which is exactly what the door exists to say.

Everything else is admitted **as published**, including the funds, the precious metals
(`XAU`, `XAG`, `XPT`, `XPD`) and the regional units (`XDR`, `XCD`, `XOF`, `XAF`, `XPF`,
`XCG`, `XSU`, `XUA`). They are real, published, and a source sending one is not obviously
wrong; the door's job is to refuse what the standard does not name, not to second-guess what
it does.

The exclusion list lives in `ingest/src/iso4217.ts` as `EXCLUDED_CODES`
(`scripts/generate-iso4217.ts` only imports it and prints it), is re-stated in the generated
module's header, and is pinned by name in `ingest/test/iso4217.test.ts` — so removing an
exclusion is a visible three-file diff, not a quiet edit.

## How to refresh

```sh
# 1. Fetch the current table to a path OUTSIDE this repo. Do not commit it.
curl -sSLo /tmp/list-one.xml \
  "https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml"

# 2. Note its published date and hash — both belong in the table above.
grep -o 'Pblshd="[^"]*"' /tmp/list-one.xml
shasum -a 256 /tmp/list-one.xml

# 3. Regenerate the committed artifacts from it.
npx tsx scripts/generate-iso4217.ts /tmp/list-one.xml

# 4. Update this file's provenance table, and the golden hashes + count in
#    ingest/test/iso4217.test.ts, to match what step 3 produced. The suite reds until
#    you do; that red is the mechanism, not a nuisance.

# 5. Delete the fetched file. It is not repository content.
rm /tmp/list-one.xml
```

SIX amends the list when currencies are created or withdrawn rather than on a calendar, so
there is no refresh cadence to schedule. **The list ages and nothing detects it
automatically** — disclosed in `KNOWN-ISSUES.md`. The consequence is bounded in the safe
direction: a newly created currency is refused at the door and surfaces as a quarantine row
naming the standard and the edition it was judged against, never as a wrong total.

## Attribution

SIX Group AG is credited in `NOTICE` as the source of the code list from which the
committed artifacts are derived.
