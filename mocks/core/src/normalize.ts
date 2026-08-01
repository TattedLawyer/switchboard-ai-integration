// The manifest resolver's company-name normalization — THE TypeScript half of the
// TS↔SQL normalizer pair. The SQL half lives inline in
// warehouse/models/identity/identity_resolution.sql (norm_companies + the
// tier2_candidates join); scripts/verify-identity.ts makes the pair CI-load-bearing:
// the oracle computes tier expectations with THIS function and asserts them against
// the SQL side's output, so any semantic drift between the two is a red CI run, not a
// latent divergence. The cross-language agreement is pinned per vector in
// ingest/test/normalizer-vectors.test.ts.

export interface NormalizationVector {
  label: string;
  input: string;
  expected: string;
}

/** The pinned vector set (Task F). Each entry is a documented real-world failure of the
 *  pre-Task-F normalizer (KNOWN-ISSUES: trailing comma, Co/PLLC, &/and, double spaces,
 *  ZWSP/NFC) plus the L2-G4 strip-set alignment vectors (ltd/corp — SQL stripped them,
 *  this resolver did not) and one pre-Task-F baseline that must keep working. */
export const NORMALIZATION_VECTORS: readonly NormalizationVector[] = [
  { label: "baseline: case + Inc suffix (pre-Task-F behavior, kept)", input: "ACME GROUP Inc.", expected: "acme group" },
  { label: "trailing comma before the suffix", input: "Acme Plumbing, Inc.", expected: "acme plumbing" },
  { label: "bare trailing comma", input: "Acme Plumbing,", expected: "acme plumbing" },
  { label: "Co suffix", input: "Summit Heating Co", expected: "summit heating" },
  { label: "PLLC suffix", input: "Ridge Dental PLLC", expected: "ridge dental" },
  { label: "Ltd suffix (L2-G4 strip-set alignment)", input: "Lakeside Logistics Ltd", expected: "lakeside logistics" },
  { label: "Corp suffix (L2-G4 strip-set alignment)", input: "Harbor Freight Corp.", expected: "harbor freight" },
  { label: "ampersand spells 'and'", input: "Smith & Sons", expected: "smith and sons" },
  { label: "spelled-out 'and' meets the ampersand form", input: "Smith And Sons", expected: "smith and sons" },
  { label: "doubled internal spaces collapse", input: "Acme  Group", expected: "acme group" },
  // Invisible-character vectors use explicit escapes: a literal ZWSP in source is the
  // exact invisible-hazard class these vectors exist to catch.
  { label: "zero-width space is stripped (L2-G8)", input: "Acme\u200B Group", expected: "acme group" },
  { label: "non-breaking space reads as a space (L2-G8)", input: "Acme\u00A0Group", expected: "acme group" },
  { label: "NFC: decomposed accents normalize to the composed form (L2-G8)", input: "Cafe\u0301 Group", expected: "caf\u00E9 group" },
];

/** Normalize a company name for identity comparison. MUST stay semantically identical
 *  to the SQL expression in identity_resolution.sql — change both or neither; the
 *  per-vector agreement pins in ingest/test/normalizer-vectors.test.ts red on drift.
 *
 *  Pipeline (order is part of the contract — the SQL nesting mirrors it exactly):
 *    1. NFC (composed forms; decomposed accents are byte-different, visually identical)
 *    2. NBSP → space; ZWSP/ZWNJ/ZWJ/BOM deleted (invisible-character hazards, L2-G8)
 *    3. lowercase
 *    4. "&" → " and " (the two spellings of the same conjunction must collide)
 *    5. whitespace runs collapse to one space; trim
 *    6. ONE trailing legal suffix stripped (inc|llc|ltd|corp|co|pllc, optional leading
 *       comma, optional trailing period) — single-strip on purpose: the idempotence
 *       caveat ("Acme Inc Ltd" → "acme inc") is a documented known-failing invariant,
 *       and looping to a fixpoint would silently eat names like "Acme Inc Ltd" to
 *       nothing a human would recognize
 *    7. any remaining trailing commas/periods/spaces stripped; trim */
export function normalizeCompanyName(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/\u00A0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s,]+(inc|llc|ltd|corp|co|pllc)\.?$/, "")
    .replace(/[\s,.]+$/, "")
    .trim();
}

/** Normalize a domain for identity comparison (case, leading "www."). */
export function normalizeDomain(raw: string): string {
  return raw.toLowerCase().replace(/^www\./, "");
}
