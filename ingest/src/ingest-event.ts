import type pg from "pg";
import type { SourceEvent } from "./server.js";

/** The tenant that pre-tenancy data and single-tenant deployments (the demo) belong to. */
export const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000000";

export interface IngestOptions {
  tenantId?: string;
}

export async function ingestEvent(
  pool: pg.Pool,
  source: string,
  event: SourceEvent,
  opts?: IngestOptions,
): Promise<"inserted" | "duplicate"> {
  // A caller that supplies the KEY explicitly but empty is a bug, not a single-tenant
  // deployment — silently substituting the default there would re-create the cross-tenant
  // collision this whole migration exists to remove, in the one code path nobody revisits.
  // Omitting it entirely still means "single tenant", which is what the demo does.
  if (opts && "tenantId" in opts && !opts.tenantId) {
    throw new Error("tenant is required: refusing to ingest with an empty tenantId");
  }
  const tenantId = opts?.tenantId ?? DEFAULT_TENANT_ID;

  const client = await pool.connect();
  try {
    await client.query("begin");

    const insertResult = await client.query(
      `insert into raw.raw_events (tenant_id, source, event_id, event_type, payload)
       values ($1, $2, $3, $4, $5) on conflict (tenant_id, source, event_id) do nothing`,
      [tenantId, source, event.event_id, event.event_type, JSON.stringify(event)],
    );

    if (insertResult.rowCount === 1) {
      // Insert was successful, write outbox row
      await client.query(
        "insert into ingest.outbox (tenant_id, source, event_id) values ($1, $2, $3)",
        [tenantId, source, event.event_id],
      );
      await client.query("commit");
      return "inserted";
    } else {
      // Duplicate event
      await client.query("commit");
      return "duplicate";
    }
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      // Ignore rollback errors
    }
    throw err;
  } finally {
    client.release();
  }
}
