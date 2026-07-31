// L1 of the numeric-integrity design: a declarative per-event-type contract, not
// hand-written validators. Ceiling, sign, scale and requiredness are each properties of
// the SOURCE, not of money (a Stripe-style ledger surface carries signed amounts, a
// HubSpot-style CRM forbids negatives and sends sparse change-only payloads, CSAT scales
// are per-vendor 1-2/1-3/1-5) — so each is declared per event type and a new source shape
// is a config change, not code surgery.
//
// The table is now the FIELD contract, not just the numeric one: it declares numeric
// fields and string fields (e.g. currency) alike; the NUMERIC_CONTRACT /
// numericContractViolation names are kept for API stability and their renaming is
// deliberately deferred (see the deferred register).
//
// This table is ALSO the registry of every event type any warehouse model consumes.
// An empty rule set means "consumed, carries no numeric fields" — present on purpose.
// The registry test in numeric-contract.test.ts extracts the event_type literals from
// every model's filter and fails the build if one is consumed but undeclared. Unknown
// event types pass the ingest door unchanged (a vendor shipping a new type must never
// cause a feed-wide quarantine); they simply cannot be CONSUMED until declared here.

export interface NumericFieldRule {
  /** Forbidden here so a rule carrying BOTH shapes (`integer: true` + `type: "string"`)
   *  is a COMPILE-TIME error. Without this, union excess-property checking admits the
   *  both-shape literal and the runtime discriminator routes it to the string branch —
   *  every numeric constraint (integer, signed, min/max) silently unenforced. */
  type?: never;
  /** Always true today; named so a future decimal-tolerant source is a declaration. */
  integer: true;
  /** Whether the field must be present. False models sparse change-only payloads. */
  required: boolean;
  /** false = negative values quarantine. true = signed surface (e.g. ledger reversals). */
  signed?: boolean;
  /** Soft ceiling: values above it are ACCEPTED and surfaced by the dbt warn test
   *  (assert_amounts_plausible.sql) — never quarantined. null = no plausible bound. */
  plausibleMax?: number | null;
  /** Hard scale bounds (e.g. CSAT): outside them quarantines. */
  min?: number;
  max?: number;
}

export interface StringFieldRule {
  /** Discriminator vs NumericFieldRule (which is recognized by its `integer` property). */
  type: "string";
  /** Whether the field must be present. false = optional (absent passes untouched). */
  required: boolean;
  /** Anchored regex SOURCE (must carry its own ^…$) the value must fully match when present. */
  pattern: string;
}

export type FieldRule = NumericFieldRule | StringFieldRule;

// Compile-time pin for the `type?: never` guard above (A2 review I2 / re-review R1).
// It lives in SRC because ingest/tsconfig.json includes only "src" — nothing typechecks
// ingest/test/, so a pin there enforces nothing. Self-enforcing in both directions:
// while the guard holds, the literal below fails to compile and the directive absorbs
// the error; if `type?: never` is ever removed, the literal compiles and tsc fails the
// build with "unused '@ts-expect-error'". A void-ed unexported const is the cheapest
// form that preserves the FRESH-object-literal discriminant/excess-property check that
// does the rejecting — a pure type-level `extends` test would NOT fail, since
// structural assignability tolerates the extra props on non-fresh types. The literal
// must stay on one line: @ts-expect-error only covers the next line.
// @ts-expect-error — a rule carrying BOTH shapes (numeric constraints + type:"string") must not compile
const BOTH_SHAPE_RULE_IS_A_COMPILE_ERROR: FieldRule = { integer: true, required: true, type: "string", pattern: "^X$" };
void BOTH_SHAPE_RULE_IS_A_COMPILE_ERROR;

export type EventContract = Readonly<Record<string, FieldRule>>;

const MONEY = { integer: true, required: true, signed: false, plausibleMax: null } as const;

// currency is OPTIONAL by design: quarantining an event removes its non-monetary facts
// until replay, so absent (legacy pre-currency events) must pass — only present-but-
// malformed quarantines, with a reason naming the field. The pattern admits plausible
// fakes like "ABC"; the ISO-4217 allowlist is registered follow-up work.
const CURRENCY = { type: "string", required: false, pattern: "^[A-Z]{3}$" } as const;

// The hubcrm thin-event base: the researched metadata field set, all vendor-named
// (camelCase — the payload is stored verbatim). occurredAt is the vendor's ms-epoch
// clock; the door normalizes a COPY into the envelope's ISO occurred_at, the original
// stays here under the contract's eye.
const INT_REQ = { integer: true, required: true, signed: false } as const;
const HUB_THIN = {
  eventId: { ...INT_REQ },
  objectId: { ...INT_REQ },
  portalId: { ...INT_REQ },
  occurredAt: { ...INT_REQ },
  attemptNumber: { ...INT_REQ },
} as const;
const HUB_PROP = {
  propertyName:  { type: "string", required: true, pattern: "^[a-zA-Z][a-zA-Z0-9_]*$" },
  propertyValue: { type: "string", required: false, pattern: "^[\\s\\S]{0,10000}$" },
} as const;

export const NUMERIC_CONTRACT: Readonly<Record<string, EventContract>> = {
  // billing
  "invoice.created":   { amount_cents: { ...MONEY }, currency: { ...CURRENCY } },
  "invoice.paid":      { amount_cents: { ...MONEY }, currency: { ...CURRENCY } },
  "invoice.voided":    { amount_cents: { ...MONEY }, currency: { ...CURRENCY } },
  // payment.* payloads carry amount_cents but NO currency today — deliberately not
  // declared here: the table describes reality, not a wished-for shape (asymmetry noted).
  "payment.succeeded": { amount_cents: { ...MONEY, plausibleMax: 99_999_999 } }, // Stripe charge bound: 8 digits
  "payment.failed":    { amount_cents: { ...MONEY, plausibleMax: 99_999_999 } },
  "customer.created":  {},
  // crm
  "deal.updated":      { amount_cents: { ...MONEY }, currency: { ...CURRENCY } },
  "company.updated":   {},
  "company.merged":    {}, // consumed by merge_edges (identity layer), not staging
  "contact.updated":   {},
  // support
  "csat.recorded":     { score: { integer: true, required: true, min: 1, max: 5 } },
  "ticket.created":    {},
  "ticket.updated":    {},
  "ticket.solved":     {},
  // stripefeed (Task B) — the Stripe-STYLE envelope feed's types, declared ahead of
  // consumption (Task F owns the staging switch; declaration-without-consumption is the
  // registry's permitted direction). Amounts per Stripe's charge semantics: integer
  // minor units, unsigned (a negative charge amount on this surface is corruption, not
  // a reversal — refunds are their own event family), plausibleMax 99_999_999 per the
  // researched 8-digit charge bound — warn-tier by the table's own rule, never a gate.
  // customer.created is deliberately REUSED from the 2a billing declaration above: same
  // type name, same (empty) rule set — the registry is keyed by event_type, not source.
  "invoice.finalized": { amount_cents: { ...MONEY, plausibleMax: 99_999_999 }, currency: { ...CURRENCY } },
  "charge.succeeded":  { amount_cents: { ...MONEY, plausibleMax: 99_999_999 }, currency: { ...CURRENCY } },
  "charge.failed":     { amount_cents: { ...MONEY, plausibleMax: 99_999_999 }, currency: { ...CURRENCY } },
  // sheets (Task A4) — connector-born events, consumed by no warehouse model until the
  // sheet staging models land (A5+); declaration-without-consumption is the registry's
  // permitted direction. amount_cents is OPTIONAL: an empty cell or an unmapped amount
  // column means the field is absent from the event by design. Present-but-unparseable
  // amounts arrive as the RAW cell string ON PURPOSE (the connector's conservative
  // parsing passes them through) so this rule quarantines them with a reason naming the
  // field. Unsigned: a negative deal value in a book-of-business sheet is human error —
  // preserved in quarantine, never guessed at.
  "sheet.row_upserted": { amount_cents: { integer: true, required: false, signed: false }, currency: { ...CURRENCY } },
  // A tombstone carries no fields to validate; the empty set still means "declared".
  "sheet.row_deleted":  {},
  // hubcrm (Task C) — the HubSpot-STYLE thin-webhook source. `data` is the vendor event
  // VERBATIM (D7: stored exactly as received), so the rules bind the vendor's own
  // metadata fields. Sparse by design: property-change events carry ONE property;
  // creation/deletion events carry none — `required: false` is the live mechanism, and
  // explicit null is absent-equivalent (see numericContractViolation). propertyValue is
  // ALWAYS a string on this vendor's wire (or null = cleared); the pattern is
  // deliberately shape-only with a length bound — value semantics belong to the
  // hydrated snapshot, where the real field rules live. Declared ahead of warehouse
  // consumption (Task F owns the staging switch) — the registry's permitted direction.
  "company.creation":       { ...HUB_THIN },
  "company.propertyChange": { ...HUB_THIN, ...HUB_PROP },
  "company.deletion":       { ...HUB_THIN },
  "contact.creation":       { ...HUB_THIN },
  "contact.propertyChange": { ...HUB_THIN, ...HUB_PROP },
  "contact.deletion":       { ...HUB_THIN },
  "deal.creation":          { ...HUB_THIN },
  "deal.propertyChange":    { ...HUB_THIN, ...HUB_PROP },
  "deal.deletion":          { ...HUB_THIN },
  // hubcrm hydrated snapshots (Task C): hydrated records are STILL VENDOR DATA — the
  // contract applies to them exactly as to wire events. These pseudo-types are the
  // connector's validation keys (numericContractViolation over snapshot.properties);
  // no raw event ever carries them. Vendor-faithful string properties: amount_cents
  // arrives as a digit STRING on this surface, currency as a code or null (cleared —
  // passes by the absent-equivalence decision).
  "hubcrm.company.snapshot": {},
  "hubcrm.contact.snapshot": {},
  "hubcrm.deal.snapshot": {
    amount_cents: { type: "string", required: false, pattern: "^\\d{1,15}$" },
    currency:     { ...CURRENCY },
  },
};

// Declared patterns compile ONCE, at module load — never per-validation — for two reasons:
// 1. A malformed pattern SOURCE fails right here, loudly, in every test run and at every
//    process start — instead of surfacing as a SyntaxError thrown inside the zod
//    refinement (throws propagate through safeParse — the wedge class documented at
//    renderValue below — and would wedge the backfill poll loop).
// 2. Every pattern must be FULLY anchored (starts with ^, ends with $): RegExp.test has
//    substring semantics, so an unanchored pattern would silently WEAKEN the gate — an
//    under-rejection no test catches unless that field happens to have its own anchoring
//    pins. The assertion is a prefix/suffix CONVENTION check, not a regex parser: it
//    catches the common forgot-the-anchors mistake, while pathological shapes (a
//    top-level alternation like `^A|B$`) still pass — accepted because patterns are
//    code-reviewed `as const` constants; auto-wrapping as `^(?:…)$` was rejected since
//    it silently rewrites declared intent (re-review R2).
function compileAnchoredPattern(where: string, source: string): RegExp {
  if (!source.startsWith("^") || !source.endsWith("$")) {
    throw new Error(
      `${where}: pattern ${JSON.stringify(source)} must be fully anchored (^…$) — an unanchored pattern substring-matches and weakens the gate`,
    );
  }
  return new RegExp(source); // a malformed source throws HERE, at module load
}

const COMPILED_PATTERNS = new Map<string, RegExp>();
for (const [eventType, contract] of Object.entries(NUMERIC_CONTRACT)) {
  for (const [field, rule] of Object.entries(contract)) {
    if (rule.type === "string") {
      COMPILED_PATTERNS.set(
        rule.pattern,
        compileAnchoredPattern(`NUMERIC_CONTRACT["${eventType}"].${field}`, rule.pattern),
      );
    }
  }
}

export interface NumericViolation { field: string; reason: string; }

// Reasons embed the offending value for the operator. Rendering must be total: a
// hostile value must never make the *renderer* throw (a throw inside a zod refinement
// propagates through safeParse — verified — and would wedge the backfill poll loop),
// and must be bounded so a megabyte payload cannot flood the quarantine table.
function renderValue(v: unknown): string {
  try {
    const s = JSON.stringify(v) ?? String(v);
    return s.length > 120 ? `${s.slice(0, 120)}… (${s.length} chars)` : s;
  } catch {
    return "[value unrenderable: nesting beyond JSON.stringify limits]";
  }
}

// Storability: a JSON number that is not a safe integer either has a fractional part or
// has already lost precision at JSON.parse (|v| > 2^53) — in both cases the value we
// observe is not trustworthy as money, and values near the bigint boundary (2^63) are
// unrepresentable as exact JS numbers at all. So "storable integer" = Number.isSafeInteger.
// This subsumes the bigint-overflow case (1e20 fails here) without a razor-edge float
// comparison at 2^63.
export function numericContractViolation(
  eventType: string,
  data: Record<string, unknown>,
): NumericViolation | null {
  const contract = NUMERIC_CONTRACT[eventType];
  if (!contract) return null; // unknown event type: the door stays open (see header)
  for (const [field, rule] of Object.entries(contract)) {
    const v = data[field];
    // DECIDED (Task C, register A2 design question): explicit null on an OPTIONAL field
    // is ABSENT-EQUIVALENT. Sparse vendors serialize "no value now" as null — HubSpot
    // sends null for a cleared property, a Sheets empty cell serializes null — and a
    // cleared field is the absence of a value, not garbage. Quarantining it would turn
    // every legitimate clear into an operator incident. On a REQUIRED field null still
    // violates (requiredness means a value must exist, and null says it does not) —
    // both directions pinned in hub-hydrate.test.ts.
    if (v === undefined || v === null) {
      if (rule.required) {
        return { field, reason: `${field} is required for ${eventType} and is ${v === null ? "null" : "absent"}` };
      }
      continue;
    }
    if (rule.type === "string") {
      // Declared string field. Both branches render via the bounded, total renderValue:
      // a deep-nested or huge value here must produce a violation, never a throw
      // (refinement throws propagate through safeParse — that lesson is already paid).
      if (typeof v !== "string") {
        return { field, reason: `${field} must be a string matching ${rule.pattern}, got ${renderValue(v)}` };
      }
      // Precompiled at module load (see COMPILED_PATTERNS). The miss path exists only
      // for rules injected AFTER load (test-only table mutation); declared patterns
      // were all compiled — and anchoring-asserted — at import time.
      let re = COMPILED_PATTERNS.get(rule.pattern);
      if (!re) {
        re = compileAnchoredPattern(`${eventType}.${field}`, rule.pattern);
        COMPILED_PATTERNS.set(rule.pattern, re);
      }
      if (!re.test(v)) {
        return { field, reason: `${field} must match ${rule.pattern}, got ${renderValue(v)}` };
      }
      continue;
    }
    if (typeof v !== "number" || !Number.isSafeInteger(v)) {
      return { field, reason: `${field} must be a storable integer, got ${renderValue(v)}` };
    }
    if (rule.signed === false && v < 0) {
      return { field, reason: `${field} must be non-negative for ${eventType}, got ${v}` };
    }
    if (rule.min !== undefined && v < rule.min) {
      return { field, reason: `${field} below declared minimum ${rule.min}, got ${v}` };
    }
    if (rule.max !== undefined && v > rule.max) {
      return { field, reason: `${field} above declared maximum ${rule.max}, got ${v}` };
    }
    // plausibleMax deliberately NOT checked here: exceeding it is accepted and surfaced
    // by the dbt warn test. Rejecting a genuine large amount is a worse failure than
    // flagging it.
  }
  return null;
}
