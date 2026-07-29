// L1 of the numeric-integrity design: a declarative per-event-type contract, not
// hand-written validators. Ceiling, sign, scale and requiredness are each properties of
// the SOURCE, not of money (a Stripe-style ledger surface carries signed amounts, a
// HubSpot-style CRM forbids negatives and sends sparse change-only payloads, CSAT scales
// are per-vendor 1-2/1-3/1-5) — so each is declared per event type and a new source shape
// is a config change, not code surgery.
//
// This table is ALSO the registry of every event type any warehouse model consumes.
// An empty rule set means "consumed, carries no numeric fields" — present on purpose.
// The registry test in numeric-contract.test.ts extracts the event_type literals from
// every model's filter and fails the build if one is consumed but undeclared. Unknown
// event types pass the ingest door unchanged (a vendor shipping a new type must never
// cause a feed-wide quarantine); they simply cannot be CONSUMED until declared here.

export interface NumericFieldRule {
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

export type EventContract = Readonly<Record<string, NumericFieldRule>>;

const MONEY = { integer: true, required: true, signed: false, plausibleMax: null } as const;

export const NUMERIC_CONTRACT: Readonly<Record<string, EventContract>> = {
  // billing
  "invoice.created":   { amount_cents: { ...MONEY } },
  "invoice.paid":      { amount_cents: { ...MONEY } },
  "invoice.voided":    { amount_cents: { ...MONEY } },
  "payment.succeeded": { amount_cents: { ...MONEY, plausibleMax: 99_999_999 } }, // Stripe charge bound: 8 digits
  "payment.failed":    { amount_cents: { ...MONEY, plausibleMax: 99_999_999 } },
  "customer.created":  {},
  // crm
  "deal.updated":      { amount_cents: { ...MONEY } },
  "company.updated":   {},
  "company.merged":    {}, // consumed by merge_edges (identity layer), not staging
  "contact.updated":   {},
  // support
  "csat.recorded":     { score: { integer: true, required: true, min: 1, max: 5 } },
  "ticket.created":    {},
  "ticket.updated":    {},
  "ticket.solved":     {},
};

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
    if (v === undefined) {
      if (rule.required) return { field, reason: `${field} is required for ${eventType} and is absent` };
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
