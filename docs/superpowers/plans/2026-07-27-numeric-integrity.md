# Numeric & Monetary Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the unvalidated-money hole: every numeric field flowing from source payloads into `customer_360` is gated at the trust boundary by a declarative per-event-type contract, safely cast in staging, tested in dbt, distinguishable from zero when missing, and currency-aware.

**Architecture:** Five defence layers, each catching what the others cannot. L1 — a declarative `NUMERIC_CONTRACT` enforced via `superRefine` on the shared event schema (all doors at once). L2 — `pg_input_is_valid` safe casts in staging so a bad row already in `raw` can never kill the build. L4 — dbt tests that detect if enforcement decays. L3 — NULL-amount counters in the mart so "missing" is never reported as "zero". L5 — currency carried through instead of discarded, with cross-currency sums refused. Prerequisite Step 0 extracts the event schema to a leaf module, breaking the import cycle that forces the current duplication between the webhook door and the replay door.

**Tech Stack:** TypeScript (zod, Express 5, vitest, supertest), PostgreSQL 16 (`pg_input_is_valid`), dbt-postgres.

**Design doc:** maintained outside the repo; this plan is self-contained.

## Global Constraints

- **Nothing delivered is ever dropped.** Contract violations → quarantine (202, payload preserved, replayable), NEVER 400/drop. The existing `occurred_at` gate is the reference behavior.
- **Unknown `event_type` passes the door unchanged.** The contract is a registry of *consumed* types, not permitted ones. Nothing undeclared may be consumed by a warehouse model (pinned by the registry test, Task 2).
- **RED then GREEN, two commits per task** (repo convention: `test(...): RED — ...` then `feat(...)/fix(...): GREEN — ...`). Step 0 is refactor-shaped: its RED is a planted-divergence demonstration recorded in the report, then a single `refactor(ingest):` commit plus its test commit.
- **Every new test must be shown able to fail** (planted counter-example, evidence in the task report). A test that cannot fail is a defect.
- **DB tests:** ephemeral `freshTestDb()` only; never the dev DB. Env: `DATABASE_URL=postgres://switchboard:switchboard@localhost:5433/switchboard`, `ALLOW_DEV_SECRETS=1`.
- **Numeric bounds live in `NUMERIC_CONTRACT` (TS).** Any SQL test repeating a bound carries a comment naming `ingest/src/numeric-contract.ts` as the source of the number.
- **Do not modify identity-resolution logic** (`identity_resolution.sql`, `int_crm__canonical_companies.sql`, `merge_edges.sql`). L5 touches the mart, not identity.
- **Tenancy is live** (migration 006): `raw.raw_events` has `tenant_id` with a default — direct-insert fixtures need not supply it, and must not remove it.
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Do the work yourself — do NOT spawn or delegate to other agents; do not use the Agent tool.

---

### Task 1: Step 0 — one event schema, one module, all doors

**Files:**
- Create: `ingest/src/event-schema.ts`
- Modify: `ingest/src/server.ts` (delete local schema, import + re-export)
- Modify: `ingest/src/quarantine.ts` (delete local schema + predicates, import from leaf)
- Test: `ingest/test/event-schema-unification.test.ts`

**Interfaces:**
- Produces: `event-schema.ts` exporting `eventSchema`, `SourceEvent`, `isIsoOccurredAt`, `isAcceptableOccurredAt`, `OCCURRED_AT_MAX_AGE_MS`, `OCCURRED_AT_MAX_FUTURE_MS`. `server.ts` continues to re-export `eventSchema` and `SourceEvent` (compatibility surface for `backfill.ts`, `ingest-event.ts`, connectors, tests).
- Consumes: nothing new. Behaviour-preserving.

**Why:** `quarantine.ts:36` hand-duplicates the schema because importing it from `server.ts` would be a runtime cycle (`server.ts` already imports from `quarantine.ts` — its own comment says so). Every payload rule added later (Task 2) must apply at ALL doors at once; today that is structurally impossible. A leaf module makes the cycle impossible by construction.

- [ ] **Step 1: Write the unification pin test**

```ts
// ingest/test/event-schema-unification.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { eventSchema as fromServer } from "../src/server.js";
import { eventSchema as fromLeaf } from "../src/event-schema.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");

// Step 0 pin: the event schema exists ONCE, in the leaf module, and every door uses that
// one object. The duplication this replaces was structurally forced by an import cycle
// (see event-schema.ts header); this test is what stops it re-forming.
describe("event schema unification", () => {
  it("server re-exports the exact leaf schema object", () => {
    expect(fromServer).toBe(fromLeaf);
  });

  it("the schema shape is defined in exactly one src file", () => {
    const files = readdirSync(SRC, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts"));
    const defining = files.filter((f) =>
      readFileSync(join(SRC, f), "utf8").includes("occurred_at: z")
    );
    expect(defining).toEqual(["event-schema.ts"]);
  });

  it("both doors reject the same payload (behavioral)", () => {
    const bad = { event_id: "evt-1", event_type: "deal.updated", occurred_at: "not-a-date", data: {} };
    // The webhook door and the replay door both run this same safeParse (replay via
    // replayQuarantined). One object, one verdict.
    expect(fromLeaf.safeParse(bad).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`../src/event-schema.js` does not exist yet)

Run: `cd ingest && DATABASE_URL=... ALLOW_DEV_SECRETS=1 npx vitest run test/event-schema-unification.test.ts`
Expected: FAIL — cannot resolve `../src/event-schema.js`.

- [ ] **Step 3: Create the leaf module**

Move — verbatim, comments included — from `quarantine.ts`: `ISO_8601_SHAPE`, `isIsoOccurredAt`, the A6 comment block, `OCCURRED_AT_MAX_AGE_MS`, `OCCURRED_AT_MAX_FUTURE_MS`, `isAcceptableOccurredAt`; and from `server.ts`: the `eventSchema` definition with its three-doors comment (update the comment: it now lives WITH the schema, and the door count claim stays). Add a header comment:

```ts
// ingest/src/event-schema.ts
// The ONE definition of what may enter raw. Extracted (Step 0 of the numeric-integrity
// work) because raw has multiple doors — the webhook (server.ts), the quarantine replay
// (quarantine.ts), the backfill poll (backfill.ts), and any future connector — and all of
// them must apply the same predicate. The schema used to be duplicated between server.ts
// and quarantine.ts because importing it from server.ts into quarantine.ts would have been
// a runtime cycle (server.ts imports quarantineEvent from quarantine.ts). This module is a
// LEAF: it imports from no other src module, so a cycle is impossible by construction.
import { z } from "zod";
```

then the moved code, ending with:

```ts
export const eventSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  occurred_at: z
    .string()
    .refine((s) => isAcceptableOccurredAt(s), "occurred_at must be ISO-8601 within [now-30d, now+5m]"),
  data: z.record(z.unknown()),
});

export type SourceEvent = z.infer<typeof eventSchema>;
```

- [ ] **Step 4: Re-point `server.ts`**

Delete the local schema definition (lines 12–26). Replace with:

```ts
import { eventSchema, type SourceEvent } from "./event-schema.js";
// Compatibility re-export: backfill.ts, ingest-event.ts, the connectors and several tests
// import the schema and its type from this module. The definition lives in event-schema.ts.
export { eventSchema };
export type { SourceEvent };
```

Drop `isAcceptableOccurredAt` from the `./quarantine.js` import (no longer used here).

- [ ] **Step 5: Re-point `quarantine.ts`**

Delete the local `eventSchema` (lines 36–43) and the moved predicates/constants (lines 5–34). Add:

```ts
import { eventSchema, type SourceEvent, isIsoOccurredAt, isAcceptableOccurredAt,
  OCCURRED_AT_MAX_AGE_MS, OCCURRED_AT_MAX_FUTURE_MS } from "./event-schema.js";
// Re-export the occurred_at predicates: they historically lived here and server.ts
// documents them as "the single definition used by ALL doors" — that sentence now points
// at event-schema.ts, but existing importers keep working.
export { isIsoOccurredAt, isAcceptableOccurredAt, OCCURRED_AT_MAX_AGE_MS, OCCURRED_AT_MAX_FUTURE_MS };
```

Remove the now-unused `import type { SourceEvent } from "./server.js"` and the `z` import if nothing else uses it. Keep the door-count comment, updated to name `event-schema.ts` as the definition site.

- [ ] **Step 6: Planted-divergence RED demonstration** (evidence for the report, then revert)

Temporarily re-add a local `const eventSchema = z.object({...})` copy in `quarantine.ts` and point `replayQuarantined` at it. Run the new test: the "exactly one src file" assertion must FAIL. Revert the plant. This is the recorded proof the pin can fail.

- [ ] **Step 7: Full verification**

Run: `npm run typecheck` (root) — clean. `npm test` (root, with env) — all suites green, count unchanged from base.

- [ ] **Step 8: Commit (two commits)**

```bash
git add ingest/test/event-schema-unification.test.ts
git commit -m "test(ingest): pin the event schema to one definition all doors share"
git add ingest/src/event-schema.ts ingest/src/server.ts ingest/src/quarantine.ts
git commit -m "refactor(ingest): extract event-schema.ts — break the cycle that forced schema duplication"
```

---

### Task 2: L1 — declarative numeric contract at the trust boundary

**Files:**
- Create: `ingest/src/numeric-contract.ts`
- Modify: `ingest/src/event-schema.ts` (attach `superRefine`)
- Modify: `ingest/src/server.ts` (quarantine reason names the failing field)
- Test: `ingest/test/numeric-contract.test.ts`

**Interfaces:**
- Consumes: `eventSchema` from Task 1 (the superRefine lands on the shared schema, so the webhook, replay, and backfill doors all get it at once — that is the point of Step 0).
- Produces: `NUMERIC_CONTRACT` (registry keyed by event_type), `numericContractViolation(eventType, data): {field, reason} | null`.

- [ ] **Step 1: Write the contract module**

```ts
// ingest/src/numeric-contract.ts
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
      return { field, reason: `${field} must be a storable integer, got ${JSON.stringify(v)}` };
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
```

- [ ] **Step 2: Attach to the shared schema** (in `event-schema.ts`)

```ts
import { numericContractViolation } from "./numeric-contract.js";

export const eventSchema = z
  .object({
    /* unchanged fields */
  })
  .superRefine((ev, ctx) => {
    // The rule for `data` depends on its sibling event_type, hence superRefine. Because
    // this lives on the shared schema, every door (webhook, replay, backfill poll, future
    // connectors) enforces it at once — no door can drift.
    const violation = numericContractViolation(ev.event_type, ev.data);
    if (violation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["data", violation.field],
        message: violation.reason,
      });
    }
  });
```

Note: `numeric-contract.ts` must stay a leaf (imports nothing from src) so `event-schema.ts` remains cycle-free.

- [ ] **Step 3: Quarantine reason names the field** (in `server.ts`)

The webhook door currently quarantines with the fixed string `"schema validation failed"`. Change to:

```ts
const detail = parsed.error.issues[0];
const reason = detail
  ? `schema validation failed: ${detail.path.join(".")} — ${detail.message}`
  : "schema validation failed";
await quarantineEvent(pool, source, req.body, reason, rawBody);
```

Check the backfill door (`backfill.ts`) quarantine reason and apply the same enrichment if it also uses a fixed string. Grep tests for exact-match assertions on `"schema validation failed"` and update them to `toContain("schema validation failed")`.

- [ ] **Step 4: Write the RED tests** (`ingest/test/numeric-contract.test.ts`)

Cover, using the existing supertest + `freshTestDb()` patterns from `quarantine.test.ts`:

1. **Rejections per class** (each asserts: 202 `{quarantined: true}`, a quarantine row whose reason names the field, and `raw.raw_events` untouched): `amount_cents: "abc"` (string), `1000.5` (float), `null`, `true`, `-500000` (negative on unsigned), `1e20` (beyond safe-integer/bigint), absent `amount_cents` on `invoice.created`; `score: 0` and `score: 6` on `csat.recorded`.
2. **Four over-rejection guards** (each asserts 202 `{stored: true}` and the row lands in `raw`):
   - a valid `amount_cents` still ingests;
   - `amount_cents: 100_000_000` on `payment.succeeded` (above plausibleMax) INGESTS;
   - unknown `event_type: "invoice.refunded"` with garbage data ingests unchanged;
   - an event type declared `required: false` with the field absent ingests — add a unit-level test of `numericContractViolation` with a synthetic contract entry for this (no production type is `required: false` yet; the unit test pins the mechanism).
3. **Replay door**: quarantine a bad-amount payload via the webhook, `replayQuarantined` → `"still-invalid"`. This test FAILS if L1 is ever applied to only one door — it is the test Step 0 exists to make possible.
4. **Registry completeness**: scan ALL warehouse models:

```ts
it("every event_type consumed by any warehouse model is declared in NUMERIC_CONTRACT", () => {
  const modelsDir = join(WAREHOUSE_DIR, "models");
  const files = readdirSync(modelsDir, { recursive: true }).map(String).filter((f) => f.endsWith(".sql"));
  const consumed = new Set<string>();
  for (const f of files) {
    const sql = readFileSync(join(modelsDir, f), "utf8");
    for (const m of sql.matchAll(/'([a-z_]+\.[a-z_]+)'/g)) consumed.add(m[1]);
  }
  expect(consumed.size).toBeGreaterThanOrEqual(14); // 13 staging + company.merged; guards a silent scan break
  const declared = Object.keys(NUMERIC_CONTRACT);
  for (const type of consumed) {
    // NOT toHaveProperty: vitest treats "invoice.created" as a nested path.
    expect(declared, `event_type '${type}' is consumed by a warehouse model but undeclared`).toContain(type);
  }
});
```

5. **Property-suite compatibility**: run `ingest/test/properties.test.ts` — the generative arbitraries emit `data: {}` shapes with arbitrary event_types; unknown types pass through so they must stay green. If an arbitrary generates a DECLARED type with a violating field, that is a legitimate catch — adapt the arbitrary, don't weaken the contract.

- [ ] **Step 5: Run tests — RED** (rejection tests fail: everything currently ingests)

- [ ] **Step 6: Commit RED**, implement Steps 1–3, **run GREEN** (new file + full root suite + typecheck), **commit GREEN**

```bash
git commit -m "test(ingest): RED — money and score fields cross the trust boundary unvalidated"
git commit -m "feat(ingest): GREEN — declarative numeric contract enforced at every door at once"
```

- [ ] **Step 7: Planted counter-examples for the registry test** (report evidence): temporarily add `where event_type = 'invoice.refunded'` to any staging model → registry test FAILS naming it; revert.

---

### Task 3: L2 — safe casts in staging

**Files:**
- Modify: `warehouse/models/staging/stg_billing__invoices.sql:17`, `stg_billing__payments.sql:18`, `stg_crm__deals.sql:16`, `stg_support__csat.sql:15`
- Test: `ingest/test/staging-safe-cast.test.ts`

**Interfaces:** consumes `loadModel` (`ingest/test/helpers/load-model.ts`). No new exports.

- [ ] **Step 1: RED tests** — for each of the four models, using `loadModel` + `freshTestDb()` (follow `ordering.test.ts` / `merge-resolution.test.ts` fixture pattern): create a fixture `raw.raw_events`, insert one well-formed row and one row whose amount/score is the literal string `"abc"` **directly into raw** (bypassing L1 — the real scenario: pre-contract legacy rows, direct inserts), run the model text, assert: query does NOT throw, good row's amount intact, bad row's amount IS NULL. Also one out-of-range case (`99999999999999999999`) → NULL.
- [ ] **Step 2: Run — RED** (bare `::bigint` cast throws `invalid input syntax`).
- [ ] **Step 3: Commit RED. Implement** — in each model replace the bare cast:

```sql
    -- L2 safe cast: raw rows that never passed the ingest door (legacy, direct inserts,
    -- historical backfill) must degrade to NULL, not kill the whole build. The ingest
    -- contract (ingest/src/numeric-contract.ts) is the enforcement; this is blast-radius
    -- containment. NULLs are surfaced by the mart's unusable-amount counters (L3) and the
    -- not_null dbt tests (L4).
    case when pg_input_is_valid(invoice ->> 'amount_cents', 'bigint')
         then (invoice ->> 'amount_cents')::bigint end as amount_cents,
```

(`payment ->> 'amount_cents'` / `deal ->> 'amount_cents'` / for csat: `pg_input_is_valid(csat ->> 'score', 'integer')` then `::int`.)

- [ ] **Step 4: GREEN** — new tests + full suite + `dbt build` via the demo flow if feasible locally; **commit GREEN**.

```bash
git commit -m "test(warehouse): RED — one malformed amount in raw kills the entire dbt build"
git commit -m "fix(warehouse): GREEN — safe casts contain a bad row to one NULL, not a dead build"
```

---

### Task 4: L4 — dbt tests that detect enforcement decay

**Files:**
- Modify: `warehouse/models/staging/schema.yml` (not_null on numeric columns)
- Create: `warehouse/tests/assert_amounts_non_negative.sql`, `warehouse/tests/assert_csat_in_scale.sql`, `warehouse/tests/assert_amounts_plausible.sql`

**Interfaces:** none. Pure dbt.

- [ ] **Step 1: schema.yml** — add `data_tests: [not_null]` to `amount_cents` (invoices, payments, deals) and `score` (csat). Severity stays `error`: with L1 active nothing NULL arrives through a door, so a NULL means enforcement decayed or a direct insert — either deserves a loud build.
- [ ] **Step 2: Singular tests**

```sql
-- warehouse/tests/assert_amounts_non_negative.sql
-- L4 detection: these sources are declared signed:false in ingest/src/numeric-contract.ts
-- (the single source of numeric rules). A negative here means L1 was relaxed or bypassed.
select 'invoice' as kind, invoice_id as id, amount_cents from {{ ref('stg_billing__invoices') }} where amount_cents < 0
union all
select 'payment', payment_id, amount_cents from {{ ref('stg_billing__payments') }} where amount_cents < 0
union all
select 'deal', deal_id, amount_cents from {{ ref('stg_crm__deals') }} where amount_cents < 0
```

```sql
-- warehouse/tests/assert_csat_in_scale.sql
-- Scale bounds mirror csat.recorded in ingest/src/numeric-contract.ts (1..5).
select csat_id, score from {{ ref('stg_support__csat') }} where score not between 1 and 5
```

```sql
-- warehouse/tests/assert_amounts_plausible.sql
{{ config(severity='warn') }}
-- Plausibility ceiling (payments only; mirrors plausibleMax in ingest/src/numeric-contract.ts —
-- Stripe's 8-digit charge bound). WARN on purpose: a genuine large payment must never fail
-- a build; it must be looked at.
select payment_id, amount_cents from {{ ref('stg_billing__payments') }} where amount_cents > 99999999
```

- [ ] **Step 3: Planted counter-example evidence (Gate B — every new test shown RED once).** With the local compose stack up: insert into `raw.raw_events` one billing row with `amount_cents: -1` (passes L2, violates sign) and one `csat.recorded` with `score: 9`; run `dbt build`; record the named test failures. Then delete the planted rows, re-run, record green. Evidence in the report. (NULL-amount not_null RED: plant an `"abc"` amount row — L2 nullifies it, not_null fires.)
- [ ] **Step 4: Commits**

```bash
git commit -m "test(warehouse): RED — planted bad numerics sail through dbt untested"   # schema.yml + singular tests, with plant evidence
git commit -m "feat(warehouse): GREEN — numeric enforcement is now detected when it decays"
```

(If the plant/verify cycle makes a literal RED commit awkward — dbt tests ARE the tests — a single commit with the plant evidence in the report satisfies the gate; note it in the report.)

---

### Task 5: L3 — missing is not zero

**Files:**
- Modify: `warehouse/models/marts/customer_360.sql`
- Modify: `warehouse/models/marts/schema.yml` (document new columns if models are listed there)
- Modify: `agent/src/mcp/server.ts` (add new columns to the read-tool column allowlist)
- Test: `ingest/test/mart-missing-vs-zero.test.ts` + `warehouse/tests/assert_unusable_amounts_flagged.sql`

**Interfaces:** produces mart columns `null_amount_invoice_count`, `null_amount_deal_count`, `has_unusable_amounts`.

- [ ] **Step 1: RED test** — `loadModel('models/marts/customer_360.sql', refMap)` with fixture tables for every ref (follow `merge-resolution.test.ts`, which already fixtures multi-ref models). Scenario: an entity with one invoice whose `amount_cents` is NULL (post-L2 shape) and one valid invoice. Assert: `total_invoiced_cents` sums only the valid one, `null_amount_invoice_count = 1`, `has_unusable_amounts = true`; a clean entity has count 0 / flag false. Expect FAIL (columns don't exist).
- [ ] **Step 2: Implement** — in `customer_360.sql`:

In `deals` CTE add: `count(*) filter (where d.amount_cents is null) as null_amount_deal_count,`
In `billing` CTE add: `count(*) filter (where i.invoice_id is not null and i.amount_cents is null) as null_amount_invoice_count,`
In the final select add:

```sql
    coalesce(d.null_amount_deal_count, 0)    as null_amount_deal_count,
    coalesce(b.null_amount_invoice_count, 0) as null_amount_invoice_count,
    -- L3: coalesce(sum(...), 0) renders "no amount" and "zero" identically; these counters
    -- make an entity with unusable amounts visibly incomplete instead of confidently zero.
    (coalesce(d.null_amount_deal_count, 0) + coalesce(b.null_amount_invoice_count, 0)) > 0
                                             as has_unusable_amounts,
```

- [ ] **Step 3: Singular warn test**

```sql
-- warehouse/tests/assert_unusable_amounts_flagged.sql
{{ config(severity='warn') }}
-- Surfaces entities whose sums exclude unusable (NULL) amounts. WARN: the mart stays
-- usable; the number is just visibly incomplete rather than silently smaller.
select entity_id, null_amount_invoice_count, null_amount_deal_count
from {{ ref('customer_360') }} where has_unusable_amounts
```

- [ ] **Step 4:** add the two count columns + flag to the `agent/src/mcp/server.ts` allowlist. GREEN: new test + full suite + typecheck. Planted evidence: warn test fires on the Step 3 plant from Task 4's procedure.
- [ ] **Step 5: Commits** (`test(warehouse): RED — a NULL amount is reported as confident zero` / `feat(warehouse): GREEN — missing amounts are counted and flagged, never zeroed`)

---

### Task 6: L5 — currency carried, cross-currency sums refused

**Files:**
- Modify: `mocks/core/src/manifest.ts` (Deal type + generator gain `currency: "USD"`)
- Modify: `warehouse/models/staging/stg_billing__invoices.sql`, `stg_crm__deals.sql` (carry `currency`)
- Modify: `warehouse/models/marts/customer_360.sql` (currency-aware sums)
- Modify: `agent/src/mcp/server.ts` (allowlist), `agent/src/host/report.ts` (mixed-currency rendering)
- Test: `ingest/test/mart-currency.test.ts`; extend `warehouse/tests/` with `assert_no_mixed_currency_totals.sql`

**Interfaces:** produces mart columns `billing_currency` (text, NULL when mixed), `deal_currency` (text, NULL when mixed), `has_mixed_currency` (bool). Sum columns become NULL when currencies are mixed — they must never be a cross-currency total.

- [ ] **Step 1: RED test** — fixture two invoices for one entity, `currency: 'USD'` and `currency: 'EUR'`: assert `total_invoiced_cents IS NULL`, `has_mixed_currency = true`. Single-currency entity: sums intact, `billing_currency = 'USD'`, flag false. Expect FAIL.
- [ ] **Step 2: Implement**
  - `manifest.ts`: `export type Deal = { ...; currency: "USD" }` and generator emits it. (Invoice already has it.)
  - `stg_billing__invoices.sql`: add `invoice ->> 'currency' as currency,` — plain text column, no cast needed. `stg_crm__deals.sql`: same.
  - `customer_360.sql` billing CTE:

```sql
billing as (
    select bl.entity_id,
           count(distinct i.currency)              as invoice_currency_count,
           min(i.currency)                         as billing_currency_raw,
           -- L5: a total across two currencies is not a number, it is a mistake. When
           -- currencies mix, the sums become NULL and has_mixed_currency flags the row;
           -- the report renders the condition instead of a figure.
           case when count(distinct i.currency) <= 1
                then coalesce(sum(i.amount_cents), 0) end                                  as total_invoiced_cents,
           case when count(distinct i.currency) <= 1
                then coalesce(sum(i.amount_cents) filter (where i.status = 'paid'), 0) end as total_paid_cents,
           count(distinct i.invoice_id) filter (where i.status = 'created')                as open_invoice_count
    from billing_link bl
    left join {{ ref('stg_billing__invoices') }} i on i.customer_id = bl.customer_id
    group by bl.entity_id
),
```

  Deals CTE analogously (`deal_currency_raw`, `open_deal_amount_cents` guarded the same way). Final select:

```sql
    case when b.invoice_currency_count <= 1 then b.billing_currency_raw end as billing_currency,
    case when d.deal_currency_count   <= 1 then d.deal_currency_raw   end as deal_currency,
    (coalesce(b.invoice_currency_count, 0) > 1 or coalesce(d.deal_currency_count, 0) > 1)
                                                                          as has_mixed_currency,
```

  **Important:** the existing final-select `coalesce(b.total_invoiced_cents, 0)` lines would erase the NULL-when-mixed signal — change those three sum columns to plain pass-through with the no-billing case handled inside the CTE coalesce (as above), i.e. final select emits `b.total_invoiced_cents` (no outer coalesce) but keep `coalesce(..., 0)` for entities with NO billing rows via a `case when b.entity_id is null then 0 else b.total_invoiced_cents end`. State in a comment: NULL now means "mixed currency", 0 means "no billing".
  - `warehouse/tests/assert_no_mixed_currency_totals.sql` (severity error): `select entity_id from {{ ref('customer_360') }} where has_mixed_currency and (total_invoiced_cents is not null or total_paid_cents is not null or open_deal_amount_cents is not null)`.
  - `report.ts`: where `usd(...)` renders sums, render `"⚠ mixed currency"` when the value is null and `has_mixed_currency` — pull the flag into the report query if not already selected (`select *` may already carry it; verify).
  - `agent/src/mcp/server.ts`: extend the column allowlist with `billing_currency`, `deal_currency`, `has_mixed_currency`.
- [ ] **Step 3: Downstream sweep** — run demo assertions locally (`./scripts/demo.sh` + `scripts/verify-identity.ts` via check-demo): all-USD synthetic data must produce IDENTICAL results to before (288/288/288, oracle PASS). Any drift = a bug in the guard, not a baseline to update.
- [ ] **Step 4: GREEN + commits** (`test(warehouse): RED — two currencies collapse into one confident wrong total` / `feat(warehouse): GREEN — currency carried end-to-end, cross-currency totals refused`)

---

### Final wave (after Task 6)

- Whole-branch review (most capable model): full diff `origin/phase2b..HEAD`, re-run gauntlet (typecheck, full suite, demo, chaos, RED-detector).
- Security pass on the diff (contract module handles untrusted input).
- Docs: RUNBOOK env/behavior deltas if any; KNOWN-ISSUES: L1-cannot-help-doorless-rows note (design §8.3), plausibleMax provenance note.
- Register updates (Gate E): resolve "eventSchema duplicated server/quarantine" Phase-1 residual (Step 0 closes it); log the TS↔SQL bound duplication as [DEBT] with the pointer-comment mitigation.
