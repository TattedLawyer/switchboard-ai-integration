// The sheet-snapshot connector (Phase 2b Task A4): CDC over a mutable document.
//
// A Google-Sheets-shaped source has no event feed, no ledger file, no event ids, and no
// event clock — the grid mutates in place. This connector manufactures the whole event
// paradigm from content (see sheet-canonical.ts) and pushes every derived event through
// the SAME door as every other source: unstorable-divert → eventSchema.safeParse →
// quarantine failures → ingestEvent.
//
// Stateless by design (decision 1): "last known state" is DERIVED from raw — the latest
// sheet.row_upserted / sheet.row_deleted per row_key, whose content hash rides in the
// payload. No connector state table, no cursor: one source of truth, and idempotency
// falls out of (tenant_id, source, event_id) uniqueness. A failed cycle costs nothing;
// the next cycle is a full fresh diff.

import type pg from "pg";
import type {
  Connector,
  ConnectorCatchUpOptions,
  ConnectorReconcileOptions,
  ConnectorReconcileResult,
} from "./types.js";
import type { ReconcileReport } from "../reconcile.js";
import { eventSchema } from "../event-schema.js";
import { DEFAULT_TENANT_ID, ingestEvent } from "../ingest-event.js";
import { jsonbUnstorableReason, quarantineEvent } from "../quarantine.js";
import {
  KEY_FIELDS,
  SHEET_SOURCE,
  canonicalRowContent,
  canonicalStringify,
  contentHash,
  parseAmountToCents,
  resolveHeaderMapping,
  type CanonicalField,
  type ColumnMap,
  type HeaderMapping,
} from "./sheet-canonical.js";

export interface SheetSnapshotConnectorOptions {
  /** Base URL of the sheet's snapshot API (GET /snapshot — the combined atomic read). */
  baseUrl: string;
  tenantId?: string;
  /** Per-request AbortSignal.timeout — no black-hole wedge (decision 7). Default 5000ms. */
  timeoutMs?: number;
  /** Truncated exponential backoff policy for 429s: min((2^n)*base + jitter, cap),
   *  bounded attempts, then a loud failure. */
  backoff?: { baseMs?: number; capMs?: number; maxAttempts?: number };
  columnMap?: ColumnMap;
}

export interface SheetCatchUpReport {
  ingested: number;
  duplicates: number;
  quarantined: number;
  /** Degradations noted per decision 4: mapped-but-missing (non-key) columns, etc. */
  degradations: string[];
}

/**
 * Extends the seam's ledger-era report shape rather than forking it, so the existing
 * `report?: ReconcileReport` contract admits it structurally. Field semantics for a
 * snapshot source: `ledger` = rows in the sheet's own current state (the sheet IS its
 * ledger), `raw` = live rows derived from raw.raw_events, `rawDuplicates` = 0 by the
 * same uniqueness argument as reconcile.ts. `stale` is the snapshot-only category:
 * present on both sides but content hash differs.
 */
export interface SheetReconcileReport extends ReconcileReport {
  stale: string[];
}

/** Read-path counters, observable so tests can pin "bounded retries actually happened". */
export interface SheetFetchStats {
  requests: number;
  retried429: number;
}

/** One snapshot: the grid's rows joined to their row-attached keys by rowIndex. */
interface Snapshot {
  header: string[];
  rows: { rowKey: string; cells: string[] }[];
}

/** Raw-derived last-known state for one rowKey. live=false means the latest event is a
 *  delete; hash is the latest upsert's content hash (null only on malformed history). */
interface DerivedRow {
  live: boolean;
  hash: string | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Composite key for the supersession count map. "|" cannot occur in rowKeys (rk-NNNN),
 *  hashes (hex), or the two event type literals, so the key cannot be ambiguous. */
const occurrenceKey = (eventType: string, rowKey: string, hash: string) => `${eventType}|${rowKey}|${hash}`;

/** n=0 stays UNSUFFIXED (reviewer's refinement to the amendment): first-occurrence ids
 *  remain exactly `sheet-<rowKey>-<hash>`, so nothing already in raw — and no pair-1
 *  test — moves. Only re-sightings of previously-ingested content grow `-r<n>`. */
const supersessionSuffix = (n: number) => (n === 0 ? "" : `-r${n}`);

export class SheetSnapshotConnector implements Connector {
  readonly kind = "sheet-snapshot" as const;
  // Literal-typed: satisfies the seam's closed ConnectorSource union (review I1).
  readonly source = SHEET_SOURCE;

  private readonly fetchStats: SheetFetchStats = { requests: 0, retried429: 0 };
  private inFlight: Promise<number> | null = null;

  constructor(private readonly opts: SheetSnapshotConnectorOptions) {}

  stats(): SheetFetchStats {
    return { ...this.fetchStats };
  }

  /** Pull path: snapshot → diff vs raw-derived state → ingest the delta through the door. */
  async catchUp(pool: pg.Pool, opts?: ConnectorCatchUpOptions): Promise<number> {
    return (await this.catchUpWithReport(pool, opts)).ingested;
  }

  /** catchUp plus the degradation notes decision 4 requires the connector to surface.
   *  Kept as a widening method (not an interface change) so the seam stays untouched. */
  async catchUpWithReport(pool: pg.Pool, opts?: ConnectorCatchUpOptions): Promise<SheetCatchUpReport> {
    const baseUrl = opts?.baseUrl ?? this.opts.baseUrl;
    const tenantId = this.opts.tenantId ?? DEFAULT_TENANT_ID;

    const snapshot = await this.fetchSnapshot(baseUrl);
    const mapping = resolveHeaderMapping(snapshot.header, this.opts.columnMap);
    // Never guess the identity spine: a sheet whose key columns cannot be mapped fails
    // LOUDLY with the headers we saw, before anything touches the database.
    const missingKeys = KEY_FIELDS.filter((f) => mapping.positions[f] === undefined);
    if (missingKeys.length > 0) {
      throw new Error(
        `sheet catchUp refusing to guess: key column(s) [${missingKeys.join(", ")}] have no ` +
          `matching header (headers seen: [${snapshot.header.join(", ")}])`,
      );
    }
    const degradations = mapping.missing.map(
      (field) =>
        `mapped column "${field}" has no matching header in this snapshot — field absent ` +
        `from events (headers seen: [${snapshot.header.join(", ")}])`,
    );

    const { latest: derived, occurrences } = await this.deriveState(pool, tenantId);
    // One detection clock per cycle. Sheets have no event time — occurred_at is OUR
    // clock at diff time, which passes the ingest window gate honestly, and the payload
    // flag occurred_at_derived says so to every downstream reader.
    const detectedAt = new Date().toISOString();

    const pending: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const row of snapshot.rows) {
      seen.add(row.rowKey);
      const content = canonicalRowContent(mapping, row.cells);
      const hash = contentHash(content);
      const prior = derived.get(row.rowKey);
      if (prior !== undefined && prior.live && prior.hash === hash) continue; // unchanged
      // Supersession counter (A4.1, amended decision 2 — review C1): a row EDITED BACK
      // to a content it held earlier (A→B→A) would otherwise manufacture the id of the
      // historical event; the door would say duplicate, the revert would never land, and
      // reconcile would call the sheet's own truth `stale` forever. n = how many times
      // raw has already ingested this (row, content); n=0 keeps the bare id (zero churn
      // to existing ids), n>0 salts it with -r<n>. Computed ONLY on diff-change, so an
      // unchanged sheet still emits nothing and idempotency-by-construction survives.
      const n = occurrences.get(occurrenceKey("sheet.row_upserted", row.rowKey, hash)) ?? 0;
      pending.push(this.buildUpsert(row.rowKey, content, hash, detectedAt, n));
    }
    for (const [rowKey, prior] of derived) {
      if (!prior.live || seen.has(rowKey)) continue;
      const n =
        prior.hash === null ? 0 : occurrences.get(occurrenceKey("sheet.row_deleted", rowKey, prior.hash)) ?? 0;
      pending.push(this.buildDelete(rowKey, prior.hash, detectedAt, n));
    }

    // The standard door, mirrored from backfill.ts pollOnce exactly: unstorable divert →
    // shared schema gate → quarantine failures (never drop) → ingestEvent. Per-ROW
    // isolation: one messy human row becomes one replayable quarantine entry; its
    // batchmates ingest.
    const report: SheetCatchUpReport = { ingested: 0, duplicates: 0, quarantined: 0, degradations };
    for (const event of pending) {
      // 2b-D4 expand-phase custody for connector-born events: there are no vendor wire
      // bytes — the connector IS the origin, so its canonical serialization is the wire
      // form, stored as raw_body and reproducible from the payload byte-for-byte.
      const rawBody = canonicalStringify(event);
      const unstorable = jsonbUnstorableReason(event);
      if (unstorable !== null) {
        await quarantineEvent(pool, this.source, event, `sheet: ${unstorable}`, rawBody, tenantId);
        report.quarantined++;
        continue;
      }
      const parsed = eventSchema.safeParse(event);
      if (!parsed.success) {
        await quarantineEvent(
          pool,
          this.source,
          event,
          `sheet: ${parsed.error.issues[0]?.message ?? "schema invalid"}`,
          rawBody,
          tenantId,
        );
        report.quarantined++;
        continue;
      }
      const result = await ingestEvent(pool, this.source, parsed.data, { tenantId, rawBody });
      if (result === "inserted") report.ingested++;
      else report.duplicates++;
    }
    return report;
  }

  /**
   * Read-only comparison of a fresh snapshot vs raw-derived state — NEVER ingests, and
   * (seam header rule) is built on nothing the push path produced: it re-reads the
   * sheet's own truth over HTTP and re-derives state from raw. Integrity = the sheet is
   * readable and its metadata/values/key-mapping are consistent; when integrity fails
   * there is deliberately NO report — a diff against a snapshot we could not trust would
   * be confident and meaningless (never fabricated).
   */
  async reconcile(
    pool: pg.Pool,
    opts?: ConnectorReconcileOptions,
  ): Promise<ConnectorReconcileResult & { report?: SheetReconcileReport }> {
    const baseUrl = opts?.baseUrl ?? this.opts.baseUrl;
    const tenantId = this.opts.tenantId ?? DEFAULT_TENANT_ID;

    let snapshot: Snapshot;
    try {
      snapshot = await this.fetchSnapshot(baseUrl);
    } catch (err) {
      return { integrity: { ok: false, detail: `sheet unreadable: ${(err as Error).message}` } };
    }
    const mapping = resolveHeaderMapping(snapshot.header, this.opts.columnMap);
    const missingKeys = KEY_FIELDS.filter((f) => mapping.positions[f] === undefined);
    if (missingKeys.length > 0) {
      return {
        integrity: {
          ok: false,
          detail:
            `sheet mapping inconsistent: key column(s) [${missingKeys.join(", ")}] unmappable ` +
            `(headers seen: [${snapshot.header.join(", ")}])`,
        },
      };
    }

    // Reconcile compares CONTENT (payload hashes), never ids — the -r<n> salt is
    // invisible here, so a landed revert reads clean, exactly the property A4.1 restores.
    const { latest: derived } = await this.deriveState(pool, tenantId);
    const missing: string[] = [];
    const stale: string[] = [];
    const extra: string[] = [];
    const seen = new Set<string>();
    for (const row of snapshot.rows) {
      seen.add(row.rowKey);
      const hash = contentHash(canonicalRowContent(mapping, row.cells));
      const prior = derived.get(row.rowKey);
      if (prior === undefined || !prior.live) missing.push(row.rowKey);
      else if (prior.hash !== hash) stale.push(row.rowKey);
    }
    let liveCount = 0;
    for (const [rowKey, prior] of derived) {
      if (!prior.live) continue;
      liveCount++;
      if (!seen.has(rowKey)) extra.push(rowKey);
    }
    missing.sort();
    stale.sort();
    extra.sort();

    return {
      integrity: { ok: true },
      report: {
        // Seam-report field semantics for a snapshot source (see SheetReconcileReport):
        // the sheet IS its own ledger; rawDuplicates is structurally 0 via
        // uq_raw_events_tenant_source_event_id, same argument as reconcile.ts.
        ledger: snapshot.rows.length,
        raw: liveCount,
        missing,
        stale,
        extra,
        rawDuplicates: 0,
      },
    };
  }

  /** Schedules an early catchUp — the latency optimization fed by the mock's lossy trigger
   *  channel. The channel's lossiness is IRRELEVANT to correctness: reconcile-first is the
   *  guarantee (seam header), nudge only shortens the wait. Single-flight: concurrent
   *  nudges coalesce onto the in-flight run. HTTP wiring lands with A5's oracle. */
  async nudge(pool: pg.Pool): Promise<number> {
    if (this.inFlight === null) {
      this.inFlight = this.catchUp(pool).finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  // ── snapshot fetch ────────────────────────────────────────────────────────────────────

  /** ONE combined read per cycle (GET /snapshot): grid values and row-attached metadata
   *  from a single consistent state. Vendor-faithful — the real Sheets API can return
   *  grid data and developer metadata in one spreadsheets.get call, so atomicity is a
   *  capability of the source, not a mock convenience. History (cold review I4): the
   *  previous /values-then-/metadata pair was not transactional, and a COUNT-PRESERVING
   *  mutation between the two GETs slid past the length check while metadata rowIndexes
   *  addressed the new order against the old grid — pairing rowKey X with row Y's
   *  content and landing fabricated row states in append-only raw. With one read that
   *  intra-snapshot window is gone: interleaving now happens only BETWEEN cycles, which
   *  is ordinary next-cycle drift — reconcile against a fresh snapshot remains the
   *  guarantee, and a failed cycle costs a stateless connector nothing. */
  private async fetchSnapshot(baseUrl: string): Promise<Snapshot> {
    const snap = (await this.fetchJson(`${baseUrl}/snapshot`)) as {
      header?: unknown;
      rows?: unknown;
      metadata?: unknown;
    };
    if (!Array.isArray(snap?.header) || !Array.isArray(snap?.rows) || !Array.isArray(snap?.metadata)) {
      throw new Error("sheet snapshot malformed: /snapshot did not return the expected shape");
    }
    const gridRows = snap.rows as string[][];
    const metaRows = snap.metadata as { rowKey?: unknown; rowIndex?: unknown }[];
    if (metaRows.length !== gridRows.length) {
      throw new Error(
        `sheet snapshot inconsistent: ${gridRows.length} value row(s) vs ${metaRows.length} metadata entr(ies)`,
      );
    }
    const rows: Snapshot["rows"] = [];
    const seenKeys = new Set<string>();
    for (const entry of metaRows) {
      const { rowKey, rowIndex } = entry;
      if (typeof rowKey !== "string" || typeof rowIndex !== "number" || gridRows[rowIndex] === undefined) {
        throw new Error(`sheet snapshot inconsistent: metadata entry ${JSON.stringify(entry)} does not address a row`);
      }
      if (seenKeys.has(rowKey)) {
        throw new Error(`sheet snapshot inconsistent: duplicate rowKey ${rowKey} in metadata`);
      }
      seenKeys.add(rowKey);
      rows.push({ rowKey, cells: gridRows[rowIndex] });
    }
    return { header: snap.header as string[], rows };
  }

  /** GET with the 429/network discipline of decision 7: per-attempt AbortSignal.timeout
   *  (a black-holed endpoint is a bounded loud failure, never a wedge); on 429, the
   *  documented truncated exponential backoff min((2^n)*base + jitter, cap) with bounded
   *  attempts, then a loud failure. No retry ladder for timeouts/network errors —
   *  stateless means the next cycle re-diffs from scratch anyway. */
  private async fetchJson(url: string): Promise<unknown> {
    const timeoutMs = this.opts.timeoutMs ?? 5000;
    const { baseMs = 100, capMs = 2000, maxAttempts = 6 } = this.opts.backoff ?? {};
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let res: Response;
      this.fetchStats.requests++;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        if ((err as Error).name === "TimeoutError") {
          throw new Error(`sheet read timed out after ${timeoutMs}ms: GET ${url}`);
        }
        throw new Error(`sheet read failed: GET ${url}: ${(err as Error).message}`);
      }
      if (res.status === 429) {
        // Drain the body so the socket is released before we sleep.
        await res.text().catch(() => undefined);
        if (attempt < maxAttempts - 1) {
          this.fetchStats.retried429++;
          // Deterministic jitter (review M1): a Knuth multiplicative hash of the attempt
          // index gives a stable [0,1) fraction — repo convention treats determinism as
          // a design value, and ingest must not import the mocks' seeded prng. Same
          // truncated-exponential shape as before; backoff traces are now reproducible.
          const jitter = (Math.imul(attempt + 1, 0x9e3779b1) >>> 0) / 2 ** 32;
          await sleep(Math.min(baseMs * 2 ** attempt + jitter * baseMs, capMs));
          continue;
        }
        throw new Error(`sheet read quota-limited: GET ${url} answered 429 through ${maxAttempts} bounded attempts`);
      }
      if (!res.ok) {
        throw new Error(`sheet read failed: GET ${url} returned status ${res.status}`);
      }
      return res.json();
    }
    // Unreachable: every loop path returns or throws; TypeScript cannot see that.
    throw new Error(`sheet read failed: GET ${url} exhausted ${maxAttempts} attempts`);
  }

  // ── raw-derived state ─────────────────────────────────────────────────────────────────

  /** The connector's only memory: the latest sheet event per row_key, read back from raw.
   *  Ordered by id (the bigserial insertion order), not occurred_at — occurred_at is our
   *  own detection clock at millisecond grain and can tie across fast cycles; id is the
   *  strict order events actually entered raw.
   *
   *  Also derives the supersession counts (A4.1, amended decision 2): how many events
   *  raw already holds per (event_type, row_key, content) — the ONLY input the -r<n>
   *  suffix needs, so the counter is exactly as stateless and crash-safe as the diff:
   *  a cycle that dies before its insert re-derives the same n and mints the same id
   *  (idempotent retry); one that dies after its insert leaves latest = sheet, so the
   *  next diff emits nothing. */
  private async deriveState(
    pool: pg.Pool,
    tenantId: string,
  ): Promise<{ latest: Map<string, DerivedRow>; occurrences: Map<string, number> }> {
    const latestRes = await pool.query<{ row_key: string; event_type: string; content_hash: string | null }>(
      `select distinct on (payload->'data'->>'row_key')
              payload->'data'->>'row_key' as row_key,
              event_type,
              payload->'data'->>'content_hash' as content_hash
         from raw.raw_events
        where tenant_id = $1 and source = $2
          and event_type in ('sheet.row_upserted', 'sheet.row_deleted')
        order by payload->'data'->>'row_key', id desc`,
      [tenantId, this.source],
    );
    const latest = new Map<string, DerivedRow>();
    for (const row of latestRes.rows) {
      if (row.row_key === null) continue; // malformed history row: no key to attach state to
      latest.set(row.row_key, { live: row.event_type === "sheet.row_upserted", hash: row.content_hash });
    }
    // Suffixed re-sightings carry the SAME content_hash in the payload (only the id is
    // salted), so this count naturally includes them — n keeps incrementing across
    // repeated reverts. coalesce folds the tombstones' last_content_hash into the same
    // column so one query serves both id families.
    const countRes = await pool.query<{ event_type: string; row_key: string; hash: string | null; n: number }>(
      `select event_type,
              payload->'data'->>'row_key' as row_key,
              coalesce(payload->'data'->>'content_hash', payload->'data'->>'last_content_hash') as hash,
              count(*)::int as n
         from raw.raw_events
        where tenant_id = $1 and source = $2
          and event_type in ('sheet.row_upserted', 'sheet.row_deleted')
        group by 1, 2, 3`,
      [tenantId, this.source],
    );
    const occurrences = new Map<string, number>();
    for (const row of countRes.rows) {
      if (row.row_key === null || row.hash === null) continue;
      occurrences.set(occurrenceKey(row.event_type, row.row_key, row.hash), row.n);
    }
    return { latest, occurrences };
  }

  // ── derived events ────────────────────────────────────────────────────────────────────

  private buildUpsert(
    rowKey: string,
    content: Record<string, string>,
    hash: string,
    detectedAt: string,
    supersessions: number,
  ): Record<string, unknown> {
    const data: Record<string, unknown> = { row_key: rowKey, content_hash: hash, occurred_at_derived: true };
    for (const [field, raw] of Object.entries(content)) {
      // Conservative parsing (decision 5): only amount_cents is interpreted, and only in
      // strict shapes; an unparseable amount rides through as the RAW string so the field
      // contract quarantines it naming the field. Everything else (currency, dates,
      // notes, identity fields) is a passthrough string — currency is judged by A2's
      // ^[A-Z]{3}$ rule at the door; date rules are registered follow-up work.
      data[field as CanonicalField] =
        field === "amount_cents" ? (parseAmountToCents(raw) ?? raw) : raw;
    }
    return {
      // Content-addressed id (amended decision 2): same content ⇒ same id ⇒ duplicate at
      // ingest — EXCEPT when raw shows this content was already ingested for this row,
      // where the supersession suffix makes the re-sighting a fresh, landable event.
      event_id: `sheet-${rowKey}-${hash}${supersessionSuffix(supersessions)}`,
      event_type: "sheet.row_upserted",
      occurred_at: detectedAt,
      data,
    };
  }

  private buildDelete(
    rowKey: string,
    lastSeenHash: string | null,
    detectedAt: string,
    supersessions: number,
  ): Record<string, unknown> {
    return {
      // The last-seen hash rides in the id so the tombstone is itself content-addressed;
      // a later re-add of the same content is a NEW row (metadata dies with its row) and
      // therefore a fresh upsert id — pinned by test obligation 4. The same supersession
      // rule applies (repeated delete cycles landing on the same last-seen content) —
      // unreachable in the mock, where rowKeys die with their rows, but the id family
      // must not have a blind spot the upsert family just closed.
      event_id: `sheet-${rowKey}-del-${lastSeenHash ?? "unknown"}${supersessionSuffix(supersessions)}`,
      event_type: "sheet.row_deleted",
      occurred_at: detectedAt,
      data: { row_key: rowKey, last_content_hash: lastSeenHash, occurred_at_derived: true },
    };
  }
}
