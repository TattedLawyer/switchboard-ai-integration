import type pg from "pg";
import type { SourceEvent } from "./server.js";
import { ingestEvent, DEFAULT_TENANT_ID } from "./ingest-event.js";
import { eventSchema } from "./server.js";
import { jsonbUnstorableReason, quarantineEvent } from "./quarantine.js";

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
  opts: { limit?: number; tenantId: string; timeoutMs?: number },
): Promise<{ ingested: number; duplicates: number; quarantined: number; last_seq: number }> {
  // REQUIRED (CLOSE-3 fix round): this is the recovery path for events the push doors
  // lost, so it must land in the lane the doors write into. A default here wrote a shadow
  // row under (tenant_id, source, event_id) instead of being absorbed as a duplicate.
  if (!opts.tenantId) throw new Error("tenant is required: refusing to poll with an empty tenantId");
  const tenantId = opts.tenantId;
  const cursor = await getCursor(pool, source, tenantId);
  const limit = opts?.limit ?? 50;
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const url = `${baseUrl}/events?after=${cursor}&limit=${limit}`;
  // Per-attempt AbortSignal.timeout (debt-burn A9): the register L1-G4 discipline every
  // sibling connector already carries — a black-holed feed is a bounded loud failure,
  // never a wedge. catchUp's bounded-retry loop treats the throw like any other.
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if ((err as Error).name === "TimeoutError") {
      throw new Error(`${source} feed read timed out after ${timeoutMs}ms: GET ${url}`);
    }
    throw new Error(`${source} feed read failed: GET ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(`GET /events failed with status ${res.status}`);
  }
  // Keep the wire text: for jsonb-unstorable events diverted below it is the only safe
  // source of quarantine raw_body (re-stringifying a deep-nested payload is the very call
  // that RangeErrors).
  const pageText = await res.text();
  const page = JSON.parse(pageText) as EventsPage;

  let ingested = 0;
  let duplicates = 0;
  let quarantined = 0;
  // The cursor is OURS (debt-burn A9, discipline 1 of the connector paradigms): it may
  // only ever name a position this process VERIFIED by processing the event that holds
  // it. `page.last_seq` is the feed's claim about itself — a feed that overstates it
  // would make the cursor skip events it never served, silently and permanently.
  let maxProcessedSeq: number | null = null;
  for (const event of page.events) {
    // Strip ledger transport metadata (seq, prev_hash, hash) so poll-path stored payloads
    // match push-path payloads byte-for-byte — those fields describe the ledger's own
    // pagination/hash-chain, not the CRM event itself.
    const { seq, prev_hash, hash, ...crmEvent } = event as typeof event & {
      prev_hash?: string;
      hash?: string;
    };
    // Every branch below PROCESSES this event (ingest, duplicate-absorb, or quarantine-
    // and-preserve), so its seq is a verified position whichever way it lands.
    if (typeof seq === "number" && Number.isFinite(seq) && (maxProcessedSeq === null || seq > maxProcessedSeq)) {
      maxProcessedSeq = seq;
    }
    // Same gate as the webhook door. ingestEvent validates nothing, so without this a feed
    // could put a value in raw that throws the staging (occurred_at)::timestamptz cast — which
    // fails the whole dbt build, not just one row — or a well-formed but absurd timestamp that
    // wins every latest-state sort forever. Quarantine rather than drop, matching the webhook
    // path: a malformed event delivered to us is preserved and inspectable, never discarded.
    // Same divert the webhook door runs (server.ts) BEFORE schema validation: NUL / lone
    // surrogate / depth-past-bound payloads are unstorable as jsonb, and a depth-diverted
    // value must never reach safeParse — the contract's refinement (or any stringify of the
    // value) would RangeError, propagate through safeParse, and wedge this poll loop on the
    // same page forever (cursor only advances after the loop completes).
    const unstorable = jsonbUnstorableReason(crmEvent);
    if (unstorable !== null) {
      // No per-event wire bytes exist on the poll path (the page was parsed as a unit), so
      // preserve the FULL page text as raw_body — wider than the event, but byte-exact and
      // the only in-process representation that survives depth beyond stringify limits.
      await quarantineEvent(pool, source, crmEvent, `poll: ${unstorable} (raw_body holds the full feed page)`, pageText, tenantId);
      quarantined++;
      continue;
    }
    const parsed = eventSchema.safeParse(crmEvent);
    if (!parsed.success) {
      await quarantineEvent(pool, source, crmEvent, `poll: ${parsed.error.issues[0]?.message ?? "schema invalid"}`, undefined, tenantId);
      quarantined++;
      continue;
    }
    // raw_body stays NULL on this door (2b-D4 expand): the feed page was parsed as a UNIT,
    // so per-event wire bytes do not exist here — and re-serializing the parsed object to
    // fill the column would be a re-stringify masquerading as wire bytes, not custody.
    // Faithful connectors (Tasks B–D) capture per-event text where their paradigm provides
    // it; this legacy poll paradigm simply doesn't.
    const result = await ingestEvent(pool, source, crmEvent as SourceEvent, { tenantId });
    if (result === "inserted") ingested++;
    else duplicates++;
  }

  // Advance only after the WHOLE page is processed, and only to the max seq of events
  // actually processed from it — ingested, duplicate, or quarantined alike (a
  // quarantined event is processed and preserved; not counting it would wedge the loop
  // on one poisoned event forever, the same rule the bus connector states at its
  // cursor). An event without a numeric seq contributes no position — conservative:
  // better to re-poll a page than to guess one. Monotonic guard: a feed that re-serves
  // old events must never REWIND the cursor either.
  const nextCursor = maxProcessedSeq !== null && maxProcessedSeq > cursor ? maxProcessedSeq : cursor;
  if (nextCursor !== cursor) {
    await setCursor(pool, source, nextCursor, tenantId);
  }

  return { ingested, duplicates, quarantined, last_seq: nextCursor };
}

export async function catchUp(
  pool: pg.Pool,
  source: string,
  baseUrl: string,
  opts: { maxRounds?: number; limit?: number; maxConsecutiveFailures?: number; tenantId: string },
): Promise<number> {
  const maxRounds = opts.maxRounds ?? 10_000;
  const maxConsecutiveFailures = opts.maxConsecutiveFailures ?? 5;
  let totalIngested = 0;
  let consecutiveEmpty = 0;
  let consecutiveFailures = 0;
  let rounds = 0;
  // Sweep item 3 (the A4 treatment, ported to the poll paradigm): the budget used to
  // expire into a SILENT `return` — a partial drain reported as a finished one, the
  // exact dishonesty the sibling connectors refuse by name. And the commonest way to
  // reach it is structural, not depth: a non-empty page whose events carry no usable
  // seq (or a feed ignoring `after`) advances no cursor, so the same page re-serves
  // forever. Track the cursor across rounds: two consecutive non-empty rounds at the
  // same cursor can only repeat — fail immediately by name, never burn the budget
  // toward a misdiagnosed "deep feed".
  let prevCursor: number | null = null;

  while (consecutiveEmpty < 2) {
    if (rounds >= maxRounds) {
      // Genuine depth (real cursor progress every round, feed still serving): a loud
      // bounded failure in the sibling connectors' wording, naming the PERSISTED
      // cursor a re-run resumes from. Cursor state is consistent — pollOnce advanced
      // it after every fully-processed page.
      throw new Error(
        `${source} catchUp exceeded maxRounds=${maxRounds} with the feed still serving events — ` +
          `refusing to report a drain it did not finish; state is consistent, re-run to resume from cursor ${prevCursor ?? 0}`,
      );
    }
    rounds++;
    let result: { ingested: number; duplicates: number; quarantined: number; last_seq: number };
    try {
      result = await pollOnce(pool, source, baseUrl, { limit: opts.limit, tenantId: opts.tenantId });
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
    if (!pageEmpty && prevCursor !== null && result.last_seq === prevCursor) {
      throw new Error(
        `${source} catchUp made no cursor progress across a non-empty round (cursor ${result.last_seq}) — ` +
          "the feed re-serves the same page (events with no usable seq, or a feed ignoring `after`); " +
          "structurally unterminating, refusing to spin the budget down",
      );
    }
    prevCursor = result.last_seq;
    if (pageEmpty) {
      consecutiveEmpty++;
    } else {
      consecutiveEmpty = 0;
    }
    totalIngested += result.ingested;
  }

  return totalIngested;
}
