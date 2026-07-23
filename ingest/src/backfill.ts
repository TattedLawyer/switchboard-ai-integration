import type pg from "pg";
import type { SourceEvent } from "./server.js";
import { ingestEvent } from "./ingest-event.js";

interface EventsPage {
  events: (SourceEvent & { seq: number })[];
  last_seq: number;
}

async function getCursor(pool: pg.Pool, source: string): Promise<number> {
  const res = await pool.query(
    "select last_seq from ingest.cursors where source = $1",
    [source],
  );
  if (res.rowCount === 0) return 0;
  return Number(res.rows[0].last_seq);
}

async function setCursor(pool: pg.Pool, source: string, lastSeq: number): Promise<void> {
  await pool.query(
    `insert into ingest.cursors (source, last_seq, updated_at)
     values ($1, $2, now())
     on conflict (source) do update set last_seq = excluded.last_seq, updated_at = now()`,
    [source, lastSeq],
  );
}

export async function pollOnce(
  pool: pg.Pool,
  source: string,
  baseUrl: string,
  opts?: { limit?: number },
): Promise<{ ingested: number; duplicates: number; last_seq: number }> {
  const cursor = await getCursor(pool, source);
  const limit = opts?.limit ?? 50;
  const url = `${baseUrl}/events?after=${cursor}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET /events failed with status ${res.status}`);
  }
  const page = (await res.json()) as EventsPage;

  let ingested = 0;
  let duplicates = 0;
  for (const event of page.events) {
    // Strip ledger transport metadata (seq, prev_hash, hash) so poll-path stored payloads
    // match push-path payloads byte-for-byte — those fields describe the ledger's own
    // pagination/hash-chain, not the CRM event itself.
    const { seq, prev_hash, hash, ...crmEvent } = event as typeof event & {
      prev_hash?: string;
      hash?: string;
    };
    const result = await ingestEvent(pool, source, crmEvent as SourceEvent);
    if (result === "inserted") ingested++;
    else duplicates++;
  }

  // Only advance the cursor once every event in the page has been ingested.
  if (page.events.length > 0) {
    await setCursor(pool, source, page.last_seq);
  }

  return { ingested, duplicates, last_seq: page.events.length > 0 ? page.last_seq : cursor };
}

export async function catchUp(
  pool: pg.Pool,
  source: string,
  baseUrl: string,
  opts?: { maxRounds?: number; limit?: number; maxConsecutiveFailures?: number },
): Promise<number> {
  const maxRounds = opts?.maxRounds ?? 10_000;
  const maxConsecutiveFailures = opts?.maxConsecutiveFailures ?? 5;
  let totalIngested = 0;
  let consecutiveEmpty = 0;
  let consecutiveFailures = 0;
  let rounds = 0;

  while (consecutiveEmpty < 2 && rounds < maxRounds) {
    rounds++;
    let result: { ingested: number; duplicates: number; last_seq: number };
    try {
      result = await pollOnce(pool, source, baseUrl, { limit: opts?.limit });
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
    const pageEmpty = result.ingested === 0 && result.duplicates === 0;
    if (pageEmpty) {
      consecutiveEmpty++;
    } else {
      consecutiveEmpty = 0;
    }
    totalIngested += result.ingested;
  }

  return totalIngested;
}
