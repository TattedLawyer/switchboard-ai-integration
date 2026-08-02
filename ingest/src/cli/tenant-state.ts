import type pg from "pg";

// Close F8 (KNOWN-ISSUES CLI-scoping): a well-formed but unknown --tenant used to run a
// clean empty reconcile / list zero gaps — exit 0, indistinguishable from a healthy
// tenant. A tenant with zero recorded state ANYWHERE is more likely a typo than a truth,
// so the CLIs refuse it by name instead of PASSing. The check is EXPLICIT-FLAG-ONLY:
// default-tenant runs (flag absent) are byte-identical to before — a fresh single-tenant
// deployment must keep reconciling its own empty database without ceremony.

/** Every tenant-scoped table an operator surface reads or writes. A tenant "exists" for
 *  CLI purposes iff at least one of them has ever recorded a row for it. */
const TENANT_STATE_TABLES = [
  "raw.raw_events",
  "ingest.ingest_journal",
  "ingest.cursors",
  "ingest.gap_ledger",
  "ingest.quarantine",
  "ingest.hydrated_snapshots",
] as const;

export async function hasRecordedTenantState(pool: pg.Pool, tenantId: string): Promise<boolean> {
  const exists = TENANT_STATE_TABLES.map((t) => `exists (select 1 from ${t} where tenant_id = $1)`).join(" or ");
  const res = await pool.query<{ known: boolean }>(`select (${exists}) as known`, [tenantId]);
  return res.rows[0].known;
}

/** The one refusal string, shared so both CLIs say the same thing (checklist line 6 —
 *  records for the same condition are equally rich across surfaces). */
export function noRecordedStateMessage(tenantId: string): string {
  return (
    `no recorded state for tenant ${tenantId} — this database has never seen it ` +
    "(no raw events, journal rows, cursors, gaps, quarantine, or snapshots). " +
    "A zero-state tenant is more likely a typo than a truth; refusing to answer " +
    "rather than reporting a clean run that would read as healthy."
  );
}
