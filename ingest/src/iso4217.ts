// #37 — the ISO-4217 allowlist's SOURCE-OF-TRUTH machinery: the parser for SIX's
// published list-one.xml and the two renderers that turn it into the repo's two
// committed artifacts (the door's TypeScript module and dbt's seed).
//
// The list is never typed by hand and never fetched at build or run time. It is vendored
// at vendor/iso-4217/list-one.xml (provenance, exclusions and refresh procedure in that
// directory's README) and rendered by scripts/generate-iso4217.ts. This module is the
// rendering code path, and it lives in shipped `src` for the same reason
// numeric-bounds-seed.ts does: the consistency pins in ingest/test/iso4217.test.ts
// exercise EXACTLY this code, so a stale or hand-edited committed artifact reds the
// suite and re-running the generator is the fix.
//
// No XML library. The vendored document is a flat, machine-generated, code-reviewed
// table with no namespaces, no attributes on the elements we read, no CDATA and no
// entity references inside them — so a scan for the `<Ccy>` leaf is sufficient AND is
// itself reviewable, which a dependency would not be (the repo's zero-new-dependency
// bias is a standing constraint; see ingest/src/config.ts). Every assumption that could
// silently produce an EMPTY or TRUNCATED list is asserted below and throws, because the
// dangerous failure mode of an allowlist is not a wrong entry, it is a short list that
// quietly refuses real money.

/** The published-date attribute on the document root — carried into both artifacts so
 *  staleness is visible in a diff and readable in the door's own rejection message. */
export interface ListOne {
  published: string;
  /** Every `<Ccy>` leaf, deduplicated and sorted — INCLUDING the codes we then exclude.
   *  Parsing and policy are separated so the exclusion is a visible decision, not a
   *  side effect of the reader. */
  codes: string[];
}

/** Codes list-one publishes that are deliberately NOT admitted at the door. `XXX` is
 *  "no currency", `XTS` is "reserved for testing" — see vendor/iso-4217/README.md. */
export const EXCLUDED_CODES: readonly string[] = ["XTS", "XXX"];

/** Sanity floor. ISO-4217 has carried roughly 180 distinct codes for decades; a parse
 *  that yields materially fewer has misread the document, and shipping THAT is how an
 *  allowlist starts quarantining real currencies. Deliberately far below the true count
 *  (178 at the 2026-01-01 amendment) so a legitimate withdrawal never trips it. */
const MIN_PLAUSIBLE_CODES = 150;

export function parseListOne(xml: string): ListOne {
  const published = /<ISO_4217[^>]*\bPblshd="([^"]+)"/.exec(xml)?.[1];
  if (!published) {
    throw new Error("list-one.xml: no Pblshd attribute on the document root — refusing to render an undated list");
  }
  const entries = (xml.match(/<CcyNtry>/g) ?? []).length;
  if (entries < MIN_PLAUSIBLE_CODES) {
    throw new Error(`list-one.xml: only ${entries} <CcyNtry> elements — the document is truncated or its shape changed`);
  }
  const codes = new Set<string>();
  for (const m of xml.matchAll(/<Ccy>([^<]*)<\/Ccy>/g)) {
    const code = m[1].trim();
    // The published table carries entries with NO <Ccy> element at all (Antarctica and
    // the like); a leaf that IS present must be a well-formed alpha-3 or we have
    // misread the document rather than met an exception.
    if (!/^[A-Z]{3}$/.test(code)) {
      throw new Error(`list-one.xml: <Ccy> leaf ${JSON.stringify(code)} is not an alpha-3 code`);
    }
    codes.add(code);
  }
  if (codes.size < MIN_PLAUSIBLE_CODES) {
    throw new Error(`list-one.xml: parsed only ${codes.size} distinct codes (floor ${MIN_PLAUSIBLE_CODES}) — refusing to render`);
  }
  return { published, codes: [...codes].sort() };
}

/** The published list minus the deliberate exclusions — what the door admits. */
export function admittedCodes(list: ListOne): string[] {
  const excluded = new Set(EXCLUDED_CODES);
  for (const code of EXCLUDED_CODES) {
    if (!list.codes.includes(code)) {
      // An exclusion that no longer excludes anything is a lie in three files. If SIX
      // withdraws XXX or XTS, that is a decision to re-take, loudly.
      throw new Error(`list-one.xml no longer publishes ${code}, which EXCLUDED_CODES still removes — re-take the exclusion decision`);
    }
  }
  return list.codes.filter((c) => !excluded.has(c));
}

const GENERATED_BANNER = "// GENERATED FILE — DO NOT EDIT BY HAND.";

/** Renders ingest/src/iso4217-codes.ts: the door's copy. */
export function renderIso4217Module(list: ListOne): string {
  const codes = admittedCodes(list);
  const lines: string[] = [];
  for (let i = 0; i < codes.length; i += 8) {
    lines.push(`  ${codes.slice(i, i + 8).map((c) => `"${c}"`).join(", ")},`);
  }
  return [
    GENERATED_BANNER,
    "//",
    "// The ISO-4217 codes the ingest door admits, rendered from the vendored SIX list-one.xml",
    "// (vendor/iso-4217/ — source URL, published date and refresh procedure live in that",
    `// directory's README) by scripts/generate-iso4217.ts. Excluded as published-but-not-billable:`,
    `// ${EXCLUDED_CODES.join(", ")} — XXX is "no currency", XTS is "reserved for testing".`,
    "//",
    "// Edit the vendored XML or the generator, never this file: ingest/test/iso4217.test.ts",
    "// re-derives this content from the XML and reds on any disagreement, in either direction.",
    "",
    `/** The \`Pblshd\` attribute of the vendored list-one.xml this file was rendered from. */`,
    `export const ISO_4217_PUBLISHED = ${JSON.stringify(list.published)};`,
    "",
    `/** Sorted, deduplicated, exclusions removed. ${codes.length} codes. */`,
    "export const ISO_4217_CURRENCIES: readonly string[] = [",
    ...lines,
    "];",
    "",
    "const CURRENCY_SET: ReadonlySet<string> = new Set(ISO_4217_CURRENCIES);",
    "",
    "/** Exact, case-sensitive membership. Nothing is normalized: a lowercase code is a",
    " *  vendor bug the operator must see, not a value to quietly repair. */",
    "export function isIso4217(code: string): boolean {",
    "  return CURRENCY_SET.has(code);",
    "}",
    "",
  ].join("\n");
}

export const ISO_4217_CSV_HEADER = "currency_code";

/** Renders warehouse/seeds/iso_4217_currencies.csv: dbt's copy of the SAME list. */
export function renderIso4217Csv(list: ListOne): string {
  return [ISO_4217_CSV_HEADER, ...admittedCodes(list)].join("\n") + "\n";
}
