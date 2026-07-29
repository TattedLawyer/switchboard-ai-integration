import type pg from "pg";
import type { SourceEvent } from "./server.js";
import { ingestEvent, DEFAULT_TENANT_ID } from "./ingest-event.js";
import { eventSchema } from "./server.js";
import { quarantineEvent } from "./quarantine.js";

interface EventsPage {
  events: (SourceEvent & { seq: number })[];
  last_seq: number;
}

// Backfill position is per (tenant, source). One cursor shared across tenants would let one
// tenant's progress skip another tenant's events: source B's cursor advancing past seq 40
// would make tenant A's un-ingested 1..40 unreachable, silently and permanently.
async function getCursor(pool: pg.Pool, source: string, tenantId: string): Promise<number> {
  const res = await pool.query(
    "select last_seq from ingest.cursors where tenant_id = $1 and source = $2",
    [tenantId, source],
  );
  if (res.rowCount === 0) return 0;
  return Number(res.rows[0].last_seq);
}

async function setCursor(
  pool: pg.Pool,
  source: string,
  lastSeq: number,
  tenantId: string,
): Promise<void> {
  await pool.query(
    `insert into ingest.cursors (tenant_id, source, last_seq, updated_at)
     values ($1, $2, $3, now())
     on conflict (tenant_id, source) do update set last_seq = excluded.last_seq, updated_at = now()`,
    [tenantId, source, lastSeq],
  );
}

export async function pollOnce(
  pool: pg.Pool,
  source: string,
  baseUrl: string,
  opts?: { limit?: number; tenantId?: string },
): Promise<{ ingested: number; duplicates: number; quarantined: number; last_seq: number }> {
  const tenantId = opts?.tenantId ?? DEFAULT_TENANT_ID;
  const cursor = await getCursor(pool, source, tenantId);
  const limit = opts?.limit ?? 50;
  const url = `${baseUrl}/events?after=${cursor}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET /events failed with status ${res.status}`);
  }
  const page = (await res.json()) as EventsPage;

  let ingested = 0;
  let duplicates = 0;
  let quarantined = 0;
  for (const event of page.events) {
    // Strip ledger transport metadata (seq, prev_hash, hash) so poll-path stored payloads
    // match push-path payloads byte-for-byte — those fields describe the ledger's own
    // pagination/hash-chain, not the CRM event itself.
    const { seq, prev_hash, hash, ...crmEvent } = event as typeof event & {
      prev_hash?: string;
      hash?: string;
    };
    // Same gate as the webhook door. ingestEvent validates nothing, so without this a feed
    // could put a value in raw that throws the staging (occurred_at)::timestamptz cast — which
    // fails the whole dbt build, not just one row — or a well-formed but absurd timestamp that
    // wins every latest-state sort forever. Quarantine rather than drop, matching the webhook
    // path: a malformed event delivered to us is preserved and inspectable, never discarded.
    const parsed = eventSchema.safeParse(crmEvent);
    if (!parsed.success) {
      await quarantineEvent(pool, source, crmEvent, `poll: ${parsed.error.issues[0]?.message ?? "schema invalid"}`, undefined, tenantId);
      quarantined++;
      continue;
    }
    const result = await ingestEvent(pool, source, crmEvent as SourceEvent, { tenantId });
    if (result === "inserted") ingested++;
    else duplicates++;
  }

  // Only advance the cursor once every event in the page has been ingested.
  if (page.events.length > 0) {
    await setCursor(pool, source, page.last_seq, tenantId);
  }

  return { ingested, duplicates, quarantined, last_seq: page.events.length > 0 ? page.last_seq : cursor };
}

export async function catchUp(
  pool: pg.Pool,
  source: string,
  baseUrl: string,
  opts?: { maxRounds?: number; limit?: number; maxConsecutiveFailures?: number; tenantId?: string },
): Promise<number> {
  const maxRounds = opts?.maxRounds ?? 10_000;
  const maxConsecutiveFailures = opts?.maxConsecutiveFailures ?? 5;
  let totalIngested = 0;
  let consecutiveEmpty = 0;
  let consecutiveFailures = 0;
  let rounds = 0;

  while (consecutiveEmpty < 2 && rounds < maxRounds) {
    rounds++;
    let result: { ingested: number; duplicates: number; quarantined: number; last_seq: number };
    try {
      result = await pollOnce(pool, source, baseUrl, { limit: opts?.limit, tenantId: opts?.tenantId });
    } catch (err) {
      consecutiveFailures++;
      if (consecutiveFailures >= maxConsecutiveFailures) {
        throw err;
      }
      // Short bounded backoff before retrying a thrown error (e.g. injected 429s or a
      // transient network failure), then re-attempt the same page.
      await new Promise((resolve) => setTimeout(resolve, 25 * consecutiveFailures));
      continue;
    }

    consecutiveFailures = 0;
    // A page of nothing but quarantined events is NOT empty: treating it as empty would let
    // two such pages stop catchUp early and strand valid events further down the feed.
    const pageEmpty = result.ingested === 0 && result.duplicates === 0 && result.quarantined === 0;
    if (pageEmpty) {
      consecutiveEmpty++;
    } else {
      consecutiveEmpty = 0;
    }
    totalIngested += result.ingested;
  }

  return totalIngested;
}
