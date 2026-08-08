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
  // Close F16: the two vector classes the M-4 entry named as unpinned.
  // The SUSPECTED divergences (JS \s = full Unicode space class vs PG's regex space
  // class; .toLowerCase() vs lower() on non-ASCII uppercase) were probed on the pinned
  // stack (postgres:16-alpine, en_US.utf8, the compose AND CI image): both classes
  // AGREE there, so these vectors pin the agreement.
  //
  // The tripwire claim is NOT symmetric across the two classes, and the close review
  // (2026-08-02, C-locale scratch db, lc_collate/lc_ctype = C) measured which is which:
  //   class 2 (non-ASCII uppercase) is a REAL tripwire — under C the SQL side yields
  //     'cafÉ group' against this oracle's 'café group', so a C-locale deployment reds
  //     the SQL-side vector suite loudly instead of drifting silently.
  //   class 1 (em-space) is NOT — it collapses to 'acme group' under BOTH locales, and
  //     no locale reachable on this stack made JS \s and PG's regex space class differ
  //     on U+2003. Its tripwire is vacuous; it is still worth pinning because it FIXES
  //     the class as agreement (a future regex change on either side reds it), but it
  //     buys no locale coverage. Annotated rather than "fixed": manufacturing a
  //     divergence would mean inventing a character class neither engine actually
  //     disagrees on.
  { label: "em-space (U+2003) collapses like a space in BOTH languages (M-4 class 1, F16)", input: "Acme\u2003Group", expected: "acme group" },
  { label: "non-ASCII uppercase lowers in BOTH languages (M-4 class 2, F16)", input: "CAF\u00C9 GROUP Inc.", expected: "caf\u00E9 group" },
  // DOCUMENTED RESIDUAL DIVERGENCE (F16, at-the-vector per the close research; probed
  // 2026-08-02): Turkish dotted capital I (U+0130). In JS, toLowerCase() maps it to
  // 'i' + U+0307 combining dot (2 code points); PG lower() under en_US.utf8 yields
  // plain 'i' (1 code point). A company name carrying U+0130 therefore normalizes
  // differently across the pair: the TS oracle would expect a string the SQL side
  // never produces, and the entity would surface as a tier mismatch in
  // verify-identity (loud, not silent).
  // Deliberately NOT a shared vector (it cannot carry one `expected`) and deliberately
  // NOT "fixed": special-casing one code point would trade a documented, locale-honest
  // edge for a hand-rolled Unicode table. Revisit only if a real Turkish-market
  // engagement lands.
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

/** The pinned email vectors (close F15 — the identity-quality pass). Each is a
 *  real-world intake shape the byte-exact tier-1 join under-merged to manual review:
 *  mixed case from a human typing a form, whitespace from a copy-paste. */
export const EMAIL_NORMALIZATION_VECTORS: readonly NormalizationVector[] = [
  { label: "mixed-case local part + domain (the M-3 example)", input: "John@Acme.example.com", expected: "john@acme.example.com" },
  { label: "surrounding whitespace (copy-paste intake)", input: "  ops@ridge.example.com ", expected: "ops@ridge.example.com" },
  { label: "already normal — the rule is idempotent", input: "amy@summit.example.com", expected: "amy@summit.example.com" },
];

/** Normalize an email for identity comparison (close F15): lower-trim, the rule the
 *  sheets arm always applied, now THE shared rule for every evidence arm. MUST stay
 *  semantically identical to the SQL expression in identity_resolution.sql —
 *  nullif(lower(trim(email)), '') at every email evidence edge; the per-vector
 *  agreement pins in ingest/test/normalizer-vectors.test.ts red on drift.
 *
 *  Deliberate scope note (labeled inference, recorded with the fix): SMTP permits
 *  case-SENSITIVE local parts, so two distinct real mailboxes could in principle
 *  collide under lowering — but such a collision lands in evidence tiers that route
 *  ambiguity to manual review rather than silently merging, and the pre-fix state
 *  (ordinary mixed-case emails under-merging to manual review) was the larger real
 *  error. No plus-tag stripping, no dot-collapsing: those are provider-specific
 *  aliasing rules, not case normalization, and inventing them would manufacture
 *  false merges. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
