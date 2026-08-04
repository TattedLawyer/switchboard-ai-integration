// The stripe-feed connector (Phase 2b Task B): draining an opaque-cursor envelope feed
// honestly, including the part where honesty hurts — a 30-day retention window means
// this paradigm can PERMANENTLY lose events, and the connector's job is to say so with
// bounds instead of papering over it.
//
// Contract (phase plan §2, research-verified): GET /v1/events serves full-object
// envelopes { id: "evt_<opaque>", object: "event", type, created: s-epoch,
// data: { object } }; `limit` 1–100 (default 10); `starting_after` object-id cursor;
// `has_more` boolean; events retrievable for 30 days; response ordering UNDOCUMENTED.
//
// The three disciplines, each pinned in stripe-feed.test.ts:
//   1. has_more is the ONLY termination signal. Page emptiness and page size infer
//      nothing (the empty-page bug class fixed once at f1e7ac4 dies here by mechanism).
//   2. The cursor is OURS: the id of an event this connector actually processed —
//      chosen order-blind as max (created, id) within the page, never the response
//      array's last element (the feed shuffles) and never a feed-supplied resume hint.
//      Because ids are non-ordinal and same-second ties exist, that choice can sit
//      mid-window; the next page then RE-SERVES the tail, which idempotent ingest
//      absorbs as duplicates. Re-delivery is the safe failure mode; skipping is not.
//   3. An aged-out cursor (the documented 400 resource_missing on starting_after) is
//      the paradigm's data-loss boundary: fall back to the earliest retained event,
//      ingest forward, and report the unreachable range as an unclosable gap with
//      bounds. Forward progress plus an honest loss report — never a silent skip,
//      never a wedge.

import type pg from "pg";
import type {
  Connector,
  ConnectorCatchUpOptions,
  ConnectorReconcileOptions,
  ConnectorReconcileResult,
  GapCause,
} from "./types.js";
import { listGaps, recordGap } from "./types.js";
import type { ReconcileReport } from "../reconcile.js";
import { eventSchema } from "../event-schema.js";
import { DEFAULT_TENANT_ID, ingestEvent } from "../ingest-event.js";
import { jsonbUnstorableReason, quarantineEvent } from "../quarantine.js";

/** The source literal (registered in SOURCES — deployment surface: STRIPEFEED_BASE_URL,
 *  port 4006, INGEST_SOURCES opt-in). One spelling, shared by registry and connector. */
export const STRIPEFEED_SOURCE = "stripefeed" as const;

export interface StripeFeedConnectorOptions {
  /** Base URL of the feed (GET <baseUrl>/v1/events). */
  baseUrl: string;
  /** REQUIRED (CLOSE-3 fix round). Defaulting here is what let the wiring seam construct
   *  nil-tenant connectors while the doors wrote the configured tenant. */
  tenantId: string;
  /** Per-request AbortSignal.timeout (register L1-G4) — a black-holed feed is a bounded
   *  loud failure, never a wedge. Default 5000ms. */
  timeoutMs?: number;
  /** Truncated exponential backoff for 429s: min((2^n)*base + jitter, cap), bounded
   *  attempts, then a loud failure. Deterministic jitter (house pattern from sheets). */
  backoff?: { baseMs?: number; capMs?: number; maxAttempts?: number };
  /** Page size requested per fetch, 1–100 (vendor bound). Default 100. */
  pageLimit?: number;
}

/** An unclosable gap: events that existed, were never ingested, and have aged out of
 *  the feed's retention window. Bounds are the best knowable: the last event we DID
 *  ingest (id + its stored occurred_at, when raw still has it) up to the earliest event
 *  the feed still retains. Structurally a `UnclosableGap` (types.ts) narrowed to this
 *  paradigm's single cause — the bus paradigm carries the same shape with `reset` too,
 *  and both now PERSIST into the shared `ingest.gap_ledger` (Task D). */
export interface StripeFeedGap {
  fromEventId: string;
  /** occurred_at of the last-ingested event, read back from raw; null when the cursor
   *  event is not in raw (e.g. it was quarantined — processed, never landed). */
  fromOccurredAt: string | null;
  /** created of the earliest event still retained at fallback time; null when the feed
   *  had aged EVERYTHING out (the loss has no knowable near edge). */
  toOccurredAt: string | null;
  /** Widened from the `"retention"` literal (cold review M2): the field now carries what
   *  the ledger holds rather than a value this mapping asserts. This paradigm still only
   *  produces `retention` — that is a property of the vendor contract, not of the type. */
  cause: GapCause;
}

export interface StripeFeedCatchUpReport {
  ingested: number;
  duplicates: number;
  quarantined: number;
  /** Gaps detected during THIS run (aged-out cursor fallbacks). */
  gaps: StripeFeedGap[];
}

/**
 * Seam-report semantics for a retention-bounded feed: `ledger` = the feed's currently
 * retained event count (the paradigm's ledger-equivalent — the feed IS the interface),
 * `raw` = this source's distinct events in raw, `missing` = retained but never ingested
 * AND not quarantined — real failures, after the quarantine cross-reference below.
 * `rawDuplicates` = 0 by the same uniqueness argument as reconcile.ts. `extra` keeps
 * its "in raw, unexplained by the source" meaning: raw events the feed no longer serves
 * whose occurred_at is INSIDE the retained window — those cannot be mere age-outs. Raw
 * events older than the earliest retained event are the paradigm's normal metabolism
 * (ingested, then aged out) and are counted in `agedOutRaw`, not flagged.
 */
export interface StripeFeedReconcileReport extends ReconcileReport {
  agedOutRaw: number;
  /** Retained-but-not-in-raw events that were deliberately QUARANTINED (cold review
   *  I2, the sheets quarantined-current precedent): processed, preserved in
   *  ingest.quarantine, cursor-advanced past — by design. They sit in the feed's
   *  window for up to 30 days looking exactly like `missing`; classifying them there
   *  would red every reconcile for a month over one poisoned vendor event. `count` =
   *  quarantine rows for that event id (re-serves re-quarantine, so it accumulates). */
  quarantined: { event_id: string; count: number }[];
  /** Every gap this (tenant, source) has EVER recorded, read from the durable gap ledger
   *  — plus any live-detected one, which reconcile records before reading. Task D
   *  retired the per-process caveat that used to live here: a gap whose fallback ran in
   *  an earlier process is now re-reported, because the record is state, not memory. */
  gaps: StripeFeedGap[];
}

interface FeedEnvelope {
  id?: unknown;
  type?: unknown;
  created?: unknown;
  data?: { object?: unknown };
}

interface FeedPage {
  pageText: string;
  data: FeedEnvelope[];
  has_more: boolean;
}

/** The documented aged/unknown-cursor rejection (400 invalid_request_error /
 *  resource_missing / param starting_after). Any other non-ok stays a thrown error. */
class AgedCursorError extends Error {
  constructor(readonly cursorId: string) {
    super(`starting_after cursor ${cursorId} is no longer retrievable (resource_missing)`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class StripeFeedConnector implements Connector {
  readonly kind = "stripe-feed" as const;
  readonly source = STRIPEFEED_SOURCE;

  constructor(private readonly opts: StripeFeedConnectorOptions) {}

  async catchUp(pool: pg.Pool, opts?: ConnectorCatchUpOptions): Promise<number> {
    return (await this.catchUpWithReport(pool, opts)).ingested;
  }

  /** catchUp plus the loss accounting the paradigm demands. Widening method, not an
   *  interface change (house precedent: SheetSnapshotConnector.catchUpWithReport). */
  async catchUpWithReport(pool: pg.Pool, opts?: ConnectorCatchUpOptions): Promise<StripeFeedCatchUpReport> {
    const baseUrl = opts?.baseUrl ?? this.opts.baseUrl;
    const tenantId = this.opts.tenantId;
    const limit = opts?.limit ?? this.opts.pageLimit ?? 100;
    const maxRounds = opts?.maxRounds ?? 10_000;

    const report: StripeFeedCatchUpReport = { ingested: 0, duplicates: 0, quarantined: 0, gaps: [] };
    let cursor = await this.getCursor(pool, tenantId);

    for (let rounds = 0; ; rounds++) {
      if (rounds >= maxRounds) {
        // An endless empty-but-has_more feed (or one so deep it exceeds the budget) must
        // be a LOUD bounded failure: returning normally would report a complete drain
        // that never happened. Cursor state is consistent — re-run to continue.
        throw new Error(
          `stripefeed catchUp exceeded maxRounds=${maxRounds} with has_more still true — ` +
            "refusing to report a drain it did not finish; state is consistent, re-run to resume",
        );
      }

      let page: FeedPage;
      try {
        page = await this.fetchPage(baseUrl, cursor, limit);
      } catch (err) {
        if (err instanceof AgedCursorError) {
          // The retention boundary. The cursor names an event the feed has genuinely
          // forgotten; everything between it and the earliest retained event is
          // PERMANENTLY unreachable. Record the loss with the best knowable bounds,
          // then fall back to the feed's start and keep going — forward progress and
          // an honest report, in that order of implementation and the reverse order
          // of importance.
          const gap = await this.buildGap(pool, tenantId, baseUrl, err.cursorId, limit);
          report.gaps.push(gap);
          // Task D: the loss goes into the DURABLE ledger, not just this process's
          // memory. Idempotent by (tenant, source, cause, from_event_id), so a
          // once-a-minute backfill loop that keeps re-detecting the same permanent loss
          // writes one row, not one row per tick.
          await recordGap(pool, {
            tenantId,
            source: this.source,
            cause: gap.cause,
            fromEventId: gap.fromEventId,
            fromOccurredAt: gap.fromOccurredAt,
            toEventId: null, // this paradigm knows its far edge by TIME, not by id
            toOccurredAt: gap.toOccurredAt,
          });
          cursor = null;
          continue;
        }
        throw err;
      }

      // Order-blind processing: sort by (created, id) — created is the event's own
      // clock, id breaks same-second ties deterministically. Response position is
      // deliberately never consulted (the feed shuffles; the oracle pins invariance).
      const envelopes = [...page.data].sort((a, b) => {
        const ca = typeof a.created === "number" ? a.created : Number.MAX_SAFE_INTEGER;
        const cb = typeof b.created === "number" ? b.created : Number.MAX_SAFE_INTEGER;
        return ca - cb || String(a.id).localeCompare(String(b.id));
      });

      let deepest: { created: number; id: string } | null = null;
      for (const envelope of envelopes) {
        await this.processEnvelope(pool, tenantId, envelope, page.pageText, report);
        // Cursor candidate = max (created, id) among PROCESSED events — including
        // quarantined ones (preserved + replayable; see processEnvelope), else one
        // poisoned event would wedge the feed on itself forever.
        if (typeof envelope.id === "string" && typeof envelope.created === "number") {
          if (
            deepest === null ||
            envelope.created > deepest.created ||
            (envelope.created === deepest.created && envelope.id > deepest.id)
          ) {
            deepest = { created: envelope.created, id: envelope.id };
          }
        }
      }

      // Advance only after the WHOLE page is processed (crash between page and cursor
      // write ⇒ re-fetch ⇒ duplicates, which idempotent ingest absorbs; never loss).
      if (deepest !== null) {
        cursor = deepest.id;
        await this.setCursor(pool, tenantId, cursor);
      }

      if (!page.has_more) return report;
    }
  }

  /**
   * Authoritative comparison of the feed's own retained truth against raw. Independent
   * of the pull path's cursor: reconcile drains the WHOLE retained window from the
   * start, every run (seam rule — built on nothing catchUp produced).
   *
   * Gaps (AMENDED by Task D — the previous note here claimed a limitation that is now
   * false, and a stale invariant claim in a comment is exactly the class the Task C cold
   * review caught): gap reporting no longer depends on instance memory. Reconcile detects
   * a live gap condition (the persisted cursor names an event the feed has forgotten),
   * RECORDS it into `ingest.gap_ledger`, and then reports everything that ledger holds
   * for this (tenant, source). A catchUp-then-exit process followed by a fresh reconcile
   * process now re-reports the loss, because the witness is state.
   */
  async reconcile(
    pool: pg.Pool,
    opts?: ConnectorReconcileOptions,
  ): Promise<ConnectorReconcileResult & { report?: StripeFeedReconcileReport }> {
    const baseUrl = opts?.baseUrl ?? this.opts.baseUrl;
    const tenantId = this.opts.tenantId;

    // Full drain of the retained window. Any fetch failure (including a mid-drain aged
    // cursor, impossible unless the window moves under us) is an integrity failure:
    // no report against a truth we could not finish reading. Same bounded-loud-failure
    // discipline as catchUp (review I2): a broken feed re-serving pages must produce an
    // integrity verdict within bounds, never a wedge — detected structurally (a page
    // after a cursor can never contain the cursor event itself on an honest feed, so
    // deepest == cursor proves the feed is not advancing) with a rounds budget as the
    // backstop for shapes the structural check cannot see.
    const RECONCILE_MAX_ROUNDS = 10_000;
    const retained = new Map<string, number>(); // id → created
    try {
      let cursor: string | null = null;
      for (let rounds = 0; ; rounds++) {
        if (rounds >= RECONCILE_MAX_ROUNDS) {
          return {
            integrity: {
              ok: false,
              detail:
                `feed did not finish serving its retained window within ${RECONCILE_MAX_ROUNDS} pages — ` +
                "has_more never went false; suspect the feed is re-serving pages or its cursor is not advancing",
            },
          };
        }
        const page = await this.fetchPage(baseUrl, cursor, this.opts.pageLimit ?? 100);
        let deepest: { created: number; id: string } | null = null;
        for (const e of page.data) {
          if (typeof e.id !== "string" || e.id === "") {
            // A missing IDENTITY is genuinely fatal: this envelope cannot be compared
            // against raw at all, so the window really is unreadable.
            return {
              integrity: { ok: false, detail: `feed served an envelope with no id: ${JSON.stringify(e).slice(0, 120)}` },
            };
          }
          // A non-numeric `created` is bad DATA, not an unreadable source (Task D review
          // addendum; the bus oracle found this same shape on a 72h window, and here it
          // was blinding a THIRTY-DAY one). The drain already treats such an envelope as
          // bad data — occurred_at fails the schema gate, it is quarantined, its page
          // siblings land — and the quarantine cross-reference below exists precisely so
          // one poisoned vendor event cannot red a month of reconciles. So: the event
          // COUNTS toward the retained window (it really is there), contributes NO
          // timestamp, and is excluded from the aged-out boundary arithmetic rather than
          // corrupting it — the `Number.isNaN` guards downstream already handle NaN.
          const createdS = typeof e.created === "number" ? e.created : NaN;
          retained.set(e.id, createdS);
          // Cursor selection is order-blind on (created, id), so a timestamp-less
          // envelope must never win it: NaN comparisons are all false, which would make
          // the choice depend on arrival order. It is skipped as a candidate — the page
          // still advances on its well-formed siblings, and if a page had NOTHING else,
          // `deepest` stays null and the rounds budget bounds the drain loudly.
          if (Number.isNaN(createdS)) continue;
          if (
            deepest === null ||
            createdS > deepest.created ||
            (createdS === deepest.created && e.id > deepest.id)
          ) {
            deepest = { created: createdS, id: e.id };
          }
        }
        if (deepest !== null && deepest.id === cursor) {
          // An honest page after `starting_after=cursor` excludes the cursor event by
          // definition; seeing it again (as the page's own deepest, no less) means the
          // feed re-served the window we just read — looping would never terminate.
          return {
            integrity: {
              ok: false,
              detail: `feed is re-serving pages: page after starting_after=${cursor} still contains it — cursor not advancing`,
            },
          };
        }
        if (deepest !== null) cursor = deepest.id;
        if (!page.has_more) break;
        if (page.data.length === 0) {
          return { integrity: { ok: false, detail: "feed reports has_more with an empty page and no cursor progress" } };
        }
      }
    } catch (err) {
      return { integrity: { ok: false, detail: `feed unreadable: ${(err as Error).message}` } };
    }

    const rawRes = await pool.query<{ event_id: string; occurred_at: string | null }>(
      `select event_id, payload->>'occurred_at' as occurred_at
         from raw.raw_events
        where tenant_id = $1 and source = $2`,
      [tenantId, this.source],
    );

    const rawIds = new Set(rawRes.rows.map((r) => r.event_id));

    // Quarantine cross-reference (cold review I2): retained-but-not-in-raw splits into
    // real failures (`missing`) and deliberately-diverted events preserved in
    // ingest.quarantine (`quarantined`, with row counts — re-serves accumulate).
    const missingCandidates = [...retained.keys()].filter((id) => !rawIds.has(id));
    const quarantined: { event_id: string; count: number }[] = [];
    let missing = missingCandidates;
    if (missingCandidates.length > 0) {
      const qRes = await pool.query<{ event_id: string; count: number }>(
        `select payload->>'event_id' as event_id, count(*)::int as count
           from ingest.quarantine
          where tenant_id = $1 and source = $2 and payload->>'event_id' = any($3::text[])
          group by 1`,
        [tenantId, this.source, missingCandidates],
      );
      const qMap = new Map(qRes.rows.map((r) => [r.event_id, r.count]));
      missing = missingCandidates.filter((id) => !qMap.has(id));
      for (const id of missingCandidates) {
        if (qMap.has(id)) quarantined.push({ event_id: id, count: qMap.get(id)! });
      }
      quarantined.sort((a, b) => a.event_id.localeCompare(b.event_id));
    }
    missing = [...missing].sort();

    // The retention boundary in time: anything in raw older than the earliest retained
    // event is normal metabolism (ingested, then aged out). Anything the feed no longer
    // serves that is NOT older than that boundary cannot be an age-out — flag it.
    // Timestamp-bearing retained events only: an envelope with a non-numeric `created`
    // contributes no boundary (see the drain above). Math.min over a NaN returns NaN, and
    // `occurredMs >= NaN` is FALSE for every row — so EVERY unretained raw row would fall
    // to the `else` branch below and be counted as normal metabolism. The bucket that
    // empties is `extra`: one bad vendor timestamp would silently suppress the real
    // anomaly this reconcile exists to surface — a raw event INSIDE the window that the
    // feed no longer serves. A false NEGATIVE, which is the direction nobody notices.
    // (Recorded backwards in the commit that introduced this guard; pinned correctly by
    // the "TRAP A" test in stripe-feed.test.ts, which fails against the pre-fix code.)
    const retainedTimes = [...retained.values()].filter((s) => !Number.isNaN(s));
    const earliestRetainedS = retainedTimes.length > 0 ? Math.min(...retainedTimes) : null;
    const extra: string[] = [];
    let agedOutRaw = 0;
    for (const row of rawRes.rows) {
      if (retained.has(row.event_id)) continue;
      const occurredMs = row.occurred_at === null ? NaN : Date.parse(row.occurred_at);
      if (earliestRetainedS !== null && !Number.isNaN(occurredMs) && occurredMs >= earliestRetainedS * 1000) {
        extra.push(row.event_id);
      } else {
        agedOutRaw++;
      }
    }
    extra.sort();

    // Live gap detection, then the DURABLE read. Detection first: the persisted cursor
    // names an event the feed has forgotten and no fallback has advanced past it yet, so
    // the loss window is still observable and worth recording from here too. Then the
    // report is simply what the ledger holds — including losses this process never saw.
    const cursorNow = await this.getCursor(pool, tenantId);
    if (cursorNow !== null && !retained.has(cursorNow)) {
      const live = await this.describeGap(pool, tenantId, cursorNow, earliestRetainedS);
      await recordGap(pool, {
        tenantId,
        source: this.source,
        cause: live.cause,
        fromEventId: live.fromEventId,
        fromOccurredAt: live.fromOccurredAt,
        toEventId: null,
        toOccurredAt: live.toOccurredAt,
      });
    }
    const gaps: StripeFeedGap[] = (await listGaps(pool, tenantId, this.source))
      // A stripefeed gap always names the cursor it lost; the ledger's nullable near edge
      // exists for the bus paradigm's first-subscribe reset, which cannot occur here.
      .filter((g) => g.fromEventId !== null)
      .map((g) => ({
        fromEventId: g.fromEventId!,
        fromOccurredAt: g.fromOccurredAt,
        toOccurredAt: g.toOccurredAt,
        // Cold review M2: CARRIED, not fabricated. This paradigm can only record
        // `retention` today, so hard-coding it was correct-by-accident — but a value
        // asserted rather than read is a value that silently lies the day the assumption
        // changes, and a `reset` row filed under this source would have printed as a
        // retention loss and sent the operator to the wrong investigation.
        cause: g.cause,
      }));

    return {
      integrity: { ok: true },
      report: {
        ledger: retained.size,
        raw: rawIds.size,
        missing,
        extra,
        rawDuplicates: 0, // structurally impossible: uq (tenant_id, source, event_id)
        agedOutRaw,
        quarantined,
        gaps,
      },
    };
  }

  // ── the standard door ─────────────────────────────────────────────────────────────────

  /** Envelope → door event → unstorable divert → shared schema gate (numeric contract
   *  included) → quarantine failures (never drop) → ingestEvent. Mirrors backfill.ts
   *  pollOnce / sheet-snapshot exactly — the door count invariant (event-schema.ts)
   *  gains its next door here and applies the same predicate. */
  private async processEnvelope(
    pool: pg.Pool,
    tenantId: string,
    envelope: FeedEnvelope,
    pageText: string,
    report: StripeFeedCatchUpReport,
  ): Promise<void> {
    // Map the vendor envelope to the door shape: the full resource IS the payload data;
    // occurred_at is the envelope's own s-epoch clock, ISO-rendered. A malformed
    // envelope still goes THROUGH the door (and quarantines with a named reason) rather
    // than being dropped on the floor here.
    const event: Record<string, unknown> = {
      event_id: typeof envelope.id === "string" ? envelope.id : envelope.id ?? "",
      event_type: typeof envelope.type === "string" ? envelope.type : envelope.type ?? "",
      occurred_at:
        typeof envelope.created === "number" ? new Date(envelope.created * 1000).toISOString() : envelope.created,
      data: envelope.data?.object ?? {},
    };

    // rawBody custody (2b-D4, disclosed decision): NULL for ingested rows — the page was
    // parsed as a UNIT, so per-event wire bytes do not exist in this process, and a
    // re-serialization passed off as wire bytes is forbidden (it would be manufactured
    // custody, the exact dishonesty the column exists to prevent). Same posture as the
    // legacy poll door in backfill.ts. Quarantined rows DO carry the full page text —
    // wider than the event, but byte-exact and the only true wire representation held.
    const unstorable = jsonbUnstorableReason(event);
    if (unstorable !== null) {
      await quarantineEvent(
        pool,
        this.source,
        event,
        `stripefeed: ${unstorable} (raw_body holds the full feed page)`,
        pageText,
        tenantId,
      );
      report.quarantined++;
      return;
    }
    const parsed = eventSchema.safeParse(event);
    if (!parsed.success) {
      // Storable-but-invalid: preserved as the quarantine row's jsonb payload — the
      // replayable custody the replay CLI operates on. No rawBody here, mirroring the
      // backfill poll door: quarantineEvent's raw_body lane exists for payloads jsonb
      // CANNOT hold, and the storable branch persists payload, not wire text.
      await quarantineEvent(
        pool,
        this.source,
        event,
        `stripefeed: ${parsed.error.issues[0]?.message ?? "schema invalid"}`,
        undefined,
        tenantId,
      );
      report.quarantined++;
      return;
    }
    const result = await ingestEvent(pool, this.source, parsed.data, { tenantId });
    if (result === "inserted") report.ingested++;
    else report.duplicates++;
  }

  // ── gap accounting ────────────────────────────────────────────────────────────────────

  /** Bounds for a freshly-detected gap: near edge from raw (the cursor event's stored
   *  occurred_at), far edge from the feed's CURRENT earliest retained event. */
  private async buildGap(
    pool: pg.Pool,
    tenantId: string,
    baseUrl: string,
    cursorId: string,
    limit: number,
  ): Promise<StripeFeedGap> {
    // One un-cursored probe page. Order-blind: min created over the page, not data[0].
    let earliestS: number | null = null;
    const probe = await this.fetchPage(baseUrl, null, limit);
    for (const e of probe.data) {
      if (typeof e.created === "number" && (earliestS === null || e.created < earliestS)) earliestS = e.created;
    }
    return this.describeGap(pool, tenantId, cursorId, earliestS);
  }

  private async describeGap(
    pool: pg.Pool,
    tenantId: string,
    cursorId: string,
    earliestRetainedS: number | null,
  ): Promise<StripeFeedGap> {
    const res = await pool.query<{ occurred_at: string | null }>(
      `select payload->>'occurred_at' as occurred_at
         from raw.raw_events
        where tenant_id = $1 and source = $2 and event_id = $3`,
      [tenantId, this.source, cursorId],
    );
    return {
      fromEventId: cursorId,
      fromOccurredAt: res.rowCount === 0 ? null : res.rows[0].occurred_at,
      toOccurredAt: earliestRetainedS === null ? null : new Date(earliestRetainedS * 1000).toISOString(),
      cause: "retention",
    };
  }

  // ── cursor persistence ────────────────────────────────────────────────────────────────

  // Per (tenant, source) in ingest.cursors (migration 008 added last_event_id for
  // opaque-id feeds). Same isolation argument as backfill.ts: one cursor shared across
  // tenants would let one tenant's progress make another's events unreachable.

  private async getCursor(pool: pg.Pool, tenantId: string): Promise<string | null> {
    const res = await pool.query<{ last_event_id: string | null }>(
      "select last_event_id from ingest.cursors where tenant_id = $1 and source = $2",
      [tenantId, this.source],
    );
    return res.rowCount === 0 ? null : res.rows[0].last_event_id;
  }

  private async setCursor(pool: pg.Pool, tenantId: string, lastEventId: string): Promise<void> {
    await pool.query(
      `insert into ingest.cursors (tenant_id, source, last_seq, last_event_id, updated_at)
       values ($1, $2, 0, $3, now())
       on conflict (tenant_id, source) do update set last_event_id = excluded.last_event_id, updated_at = now()`,
      [tenantId, this.source, lastEventId],
    );
  }

  // ── fetch discipline ──────────────────────────────────────────────────────────────────

  /** GET one page. Register L1-G4 paid: per-attempt AbortSignal.timeout. On 429, the
   *  house truncated exponential backoff with DETERMINISTIC jitter (Knuth multiplicative
   *  hash of the attempt index — reproducible traces; ingest must not import the mocks'
   *  prng), bounded attempts, then a loud failure. The documented aged-cursor 400 maps
   *  to AgedCursorError; every other non-ok response throws with its status. */
  private async fetchPage(baseUrl: string, cursor: string | null, limit: number): Promise<FeedPage> {
    const timeoutMs = this.opts.timeoutMs ?? 5000;
    const { baseMs = 100, capMs = 2000, maxAttempts = 6 } = this.opts.backoff ?? {};
    const url =
      `${baseUrl}/v1/events?limit=${limit}` +
      (cursor === null ? "" : `&starting_after=${encodeURIComponent(cursor)}`);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        if ((err as Error).name === "TimeoutError") {
          throw new Error(`stripefeed read timed out after ${timeoutMs}ms: GET ${url}`);
        }
        throw new Error(`stripefeed read failed: GET ${url}: ${(err as Error).message}`);
      }

      if (res.status === 429) {
        await res.text().catch(() => undefined); // release the socket before sleeping
        if (attempt < maxAttempts - 1) {
          const jitter = (Math.imul(attempt + 1, 0x9e3779b1) >>> 0) / 2 ** 32;
          await sleep(Math.min(baseMs * 2 ** attempt + jitter * baseMs, capMs));
          continue;
        }
        throw new Error(`stripefeed rate-limited: GET ${url} answered 429 through ${maxAttempts} bounded attempts`);
      }

      const pageText = await res.text();

      if (res.status === 400 && cursor !== null) {
        // Structurally match the researched rejection (docs.stripe.com/api/errors +
        // error-codes): { error: { type: invalid_request_error, code: resource_missing,
        // param: starting_after } }. Anything else 400-shaped is OUR bug or a contract
        // drift — it must stay loud, never be absorbed as "retention".
        try {
          const body = JSON.parse(pageText) as { error?: { type?: string; code?: string; param?: string } };
          if (
            body.error?.type === "invalid_request_error" &&
            body.error?.code === "resource_missing" &&
            body.error?.param === "starting_after"
          ) {
            throw new AgedCursorError(cursor);
          }
        } catch (err) {
          if (err instanceof AgedCursorError) throw err;
          // fall through: unparseable 400 body → generic loud failure below
        }
      }
      if (!res.ok) {
        throw new Error(`stripefeed read failed: GET ${url} returned status ${res.status}`);
      }

      let parsed: { data?: unknown; has_more?: unknown };
      try {
        parsed = JSON.parse(pageText) as { data?: unknown; has_more?: unknown };
      } catch {
        throw new Error(`stripefeed page unparseable: GET ${url} returned non-JSON`);
      }
      if (!Array.isArray(parsed.data) || typeof parsed.has_more !== "boolean") {
        throw new Error(`stripefeed page malformed: GET ${url} lacks data[]/has_more`);
      }
      return { pageText, data: parsed.data as FeedEnvelope[], has_more: parsed.has_more };
    }
    // Unreachable: every loop path returns or throws; TypeScript cannot see that.
    throw new Error(`stripefeed read failed: GET ${url} exhausted ${maxAttempts} attempts`);
  }
}
