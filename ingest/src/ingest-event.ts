import type pg from "pg";
import type { SourceEvent } from "./server.js";

/** The tenant that pre-tenancy data and single-tenant deployments (the demo) belong to. */
export const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000000";

export interface IngestOptions {
  /**
   * REQUIRED (SEC-C1). Every caller must say which tenant this event belongs to, so a
   * tenant-less call is a compile error rather than a silent nil-tenant write. Before
   * this was required, the two push doors omitted it and every webhook keyed to the nil
   * tenant — which is exactly the cross-tenant collision migration 006 exists to remove.
   * Single-tenant deployments (the demo) pass DEFAULT_TENANT_ID explicitly; the service
   * passes the one tenant `resolveDeploymentTenant()` read at boot.
   */
  tenantId: string;
  /**
   * The exact wire bytes the event arrived as (2b-D4 expand phase). Present only when the
   * door genuinely holds them — the webhook request text, or a connector's canonical JSON.
   * Omitted = stored as NULL: the honest value for doors whose paradigm provides no
   * per-event text (the legacy poll feed parses a page as a unit).
   */
  rawBody?: string;
}

export async function ingestEvent(
  pool: pg.Pool,
  source: string,
  event: SourceEvent,
  opts: IngestOptions,
): Promise<"inserted" | "duplicate"> {
  // The type makes omission impossible; this guard covers the runtime case the type cannot
  // — an empty string. Silently substituting the default there would re-create the
  // cross-tenant collision this whole migration exists to remove, in the one code path
  // nobody revisits.
  if (!opts.tenantId) {
    throw new Error("tenant is required: refusing to ingest with an empty tenantId");
  }
  const tenantId = opts.tenantId;
  // Same shape as the tenantId guard: a caller that supplies the KEY but empty text is a
  // bug (no door can receive an event on zero wire bytes), and silently storing "" would
  // masquerade as custody. Omitting it entirely means "this door has no wire bytes" → NULL.
  if (opts && "rawBody" in opts && !opts.rawBody) {
    throw new Error("rawBody, when supplied, must be the non-empty wire text — omit it when the door has none");
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    const insertResult = await client.query(
      `insert into raw.raw_events (tenant_id, source, event_id, event_type, payload, raw_body)
       values ($1, $2, $3, $4, $5, $6) on conflict (tenant_id, source, event_id) do nothing`,
      [tenantId, source, event.event_id, event.event_type, JSON.stringify(event), opts.rawBody ?? null],
    );

    if (insertResult.rowCount === 1) {
      // Journal the accepted event in the same transaction (B10: ingest.ingest_journal,
      // né ingest.outbox — renamed because no relay/consumer exists to make the outbox
      // name true; see migration 011). One row per accepted event, none for duplicates:
      // the demo's equality counter and a cheap audit surface. 30-day TTL via trigger.
      await client.query(
        "insert into ingest.ingest_journal (tenant_id, source, event_id) values ($1, $2, $3)",
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
