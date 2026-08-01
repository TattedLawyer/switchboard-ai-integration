// The bus-replay connector (Phase 2b Task D): consuming an event-bus subscribe/replay
// source honestly — the fourth and last paradigm, and the only one where falling behind
// is unrecoverable BY CONSTRUCTION. A cursor feed can be re-read from its start; a
// spreadsheet can be re-snapshotted; an object store can be re-listed. A bus has a
// WINDOW, and when the window closes the events are gone from the source forever.
//
// Contract (phase plan §2, re-verified against the vendor docs 2026-07-31):
//   · "Salesforce stores platform events and change data capture events for 72 hours."
//   · "Replay ID values aren't guaranteed to be contiguous for consecutive events."
//   · "A subscriber can store a replay ID value and use it on resubscription to retrieve
//      events that are within the retention window."
//   · "On rare occasions, the stream of retained events can be reset if the Salesforce
//      org is moved to a new instance."
//   · ReplayPreset enum: LATEST | EARLIEST | CUSTOM (Subscribe RPC reference).
//   · `…fetch.replayid.corrupted` (INVALID_ARGUMENT) is the rejection for a replay id
//      that is not valid / not within the retention window.
// Modeled over HTTP/JSON, not gRPC/Avro (spec decision D12) — see mocks/casebus for the
// fidelity boundary in full.
//
// The five disciplines, each pinned in bus-replay.test.ts:
//   1. THE CURSOR IS OURS. It is the replay id of an event this connector actually
//      processed — never the server's `latest_replay_id` hint, which names events we have
//      not seen. (The one exception is a deliberate LATEST fallback, where abandoning the
//      window IS the configured intent; called out at that line.)
//   2. REPLAY IDS ARE OPAQUE. No arithmetic, no ordinal reasoning — the same lesson Task C
//      paid for by retiring `evt-N`. The mock mints them at strides of 2..97 so that
//      cursor+1 breaks in tests instead of production.
//   3. AN INVALID CURSOR HAS TWO CAUSES AND THEY MUST BE NAMED. The wire cannot tell us:
//      the vendor publishes ONE error code covering both age-out and reset. So the cause
//      is derived STRUCTURALLY from the stream identity — honest, because the documented
//      root cause of a reset is the org being moved to a new instance. Cursors therefore
//      remember which stream they came from (migration 010's `stream_id`).
//   4. AT-LEAST-ONCE MEANS DUPLICATES ARE NORMAL. They are absorbed by
//      (tenant, source, event_id) and COUNTED — a redelivery that vanishes from the
//      numbers is indistinguishable from a bug.
//   5. FORWARD PROGRESS BEATS PURITY, BUT NEVER SILENTLY. On an invalid cursor the
//      connector falls back, keeps ingesting, and reports the unreachable range as an
//      unclosable gap with bounds and cause — recorded in the DURABLE gap ledger, so the
//      loss survives the process that found it.

import type pg from "pg";
import type {
  Connector,
  ConnectorCatchUpOptions,
  ConnectorReconcileOptions,
  ConnectorReconcileResult,
  GapCause,
  GapLedgerRow,
  UnclosableGap,
} from "./types.js";
import { listGaps, recordGap } from "./types.js";
import type { ReconcileReport } from "../reconcile.js";
import { eventSchema } from "../event-schema.js";
import { DEFAULT_TENANT_ID, ingestEvent } from "../ingest-event.js";
import { jsonbUnstorableReason, quarantineEvent } from "../quarantine.js";

/** The source literal (registered in SOURCES — deployment surface: CASEBUS_BASE_URL,
 *  port 4008, INGEST_SOURCES opt-in). One spelling, shared by registry and connector. */
export const CASEBUS_SOURCE = "casebus" as const;

/** The recovery presets this connector is willing to fall back to. CUSTOM is absent on
 *  purpose: it is not a recovery, it is the normal resume path, and it is exactly what
 *  just failed. */
export type FallbackPreset = "EARLIEST" | "LATEST";

export interface BusReplayConnectorOptions {
  /** Base URL of the bus (GET <baseUrl>/subscribe). */
  baseUrl: string;
  tenantId?: string;
  /** Per-request AbortSignal.timeout (register L1-G4): a black-holed bus is a bounded
   *  loud failure, never a wedge. Default 5000ms. */
  timeoutMs?: number;
  /** Truncated exponential backoff for 429s, deterministic jitter (house pattern). */
  backoff?: { baseMs?: number; capMs?: number; maxAttempts?: number };
  /** Events requested per fetch. Default 100. */
  batchSize?: number;
  /**
   * Where to resume when the stored replay id is invalid. DEFAULT: EARLIEST (disclosed
   * decision). LATEST discards everything still retained but not yet ingested, which
   * converts an already-permanent, bounded loss into a LARGER loss that includes events
   * the source is still willing to serve. EARLIEST re-reads the retained window; the only
   * cost is duplicates, which at-least-once delivery makes routine anyway, and the benefit
   * is that the gap's far edge is the earliest retained event rather than "now". It is
   * also the vendor's own documented advice for this situation — the Subscribe RPC
   * reference recommends EARLIEST "after a client has been disconnected for more than 3
   * days and the last saved replay ID is no longer valid". LATEST stays available for a
   * deployment that would rather be current than complete.
   */
  fallbackPreset?: FallbackPreset;
}

/** An unclosable gap on this paradigm: events that existed on the bus, were never
 *  ingested, and are no longer served. Both causes live here — unlike the stripefeed
 *  gap, which can only ever be `retention`. */
export interface BusGap extends UnclosableGap {
  toEventId: string | null;
}

export interface BusReplayCatchUpReport {
  ingested: number;
  /** Redeliveries absorbed by (tenant, source, event_id). At-least-once delivery makes
   *  this a NORMAL number, not an error count — which is why it is reported rather than
   *  swallowed. */
  duplicates: number;
  quarantined: number;
  /** Gaps detected during THIS run. Also persisted to ingest.gap_ledger. */
  gaps: BusGap[];
}

/**
 * Seam-report semantics for a window-bounded bus: `ledger` = the events the bus currently
 * retains (this paradigm's ledger-equivalent — there is no ledger file and no push
 * channel, the subscription IS the interface), `raw` = this source's distinct events in
 * raw, `missing` = retained but never ingested AND not quarantined. `extra` keeps its "in
 * raw, unexplained by the source" meaning: raw events the bus no longer serves whose
 * occurred_at is INSIDE the retained window. Events older than the earliest retained one
 * are the window's normal metabolism (ingested, then aged out) and are counted in
 * `agedOutRaw`, not flagged.
 */
export interface BusReconcileReport extends ReconcileReport {
  agedOutRaw: number;
  /** Retained-but-not-in-raw events that were deliberately QUARANTINED — processed,
   *  preserved, cursor-advanced past. Classifying them as `missing` would red every
   *  reconcile for three days over one poisoned vendor event (the stripefeed precedent). */
  quarantined: { event_id: string; count: number }[];
  /** The DURABLE record, not this process's memory: every gap ever recorded for this
   *  (tenant, source), each carrying its acknowledgement state so the operator surfaces
   *  can gate on UNACKNOWLEDGED losses only. */
  gaps: GapLedgerRow[];
}

interface EventFrame {
  replay_id?: unknown;
  event?: { id?: unknown; type?: unknown; event_time?: unknown; payload?: unknown };
}

interface Batch {
  /** Each entry keeps its own WIRE LINE — this paradigm's framing gives every event a
   *  genuine per-event wire text, so raw_body custody here is real rather than a
   *  re-serialization (which the stripefeed precedent forbids outright). */
  events: { frame: EventFrame; line: string }[];
  hasMore: boolean;
  streamId: string | null;
  latestReplayId: string | null;
}

/** The documented `…replayid.corrupted` rejection. Deliberately carries NO cause: the
 *  vendor serves one code for both age-out and reset, and inventing a distinction the
 *  wire does not make would be fabricated fidelity. */
class CorruptedCursorError extends Error {
  constructor(readonly replayId: string) {
    super(`replay id ${replayId} is no longer valid (…fetch.replayid.corrupted)`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class BusReplayConnector implements Connector {
  readonly kind = "bus-replay" as const;
  readonly source = CASEBUS_SOURCE;

  constructor(private readonly opts: BusReplayConnectorOptions) {}

  async catchUp(pool: pg.Pool, opts?: ConnectorCatchUpOptions): Promise<number> {
    return (await this.catchUpWithReport(pool, opts)).ingested;
  }

  /** catchUp plus the loss accounting the paradigm demands (widening method, house
   *  precedent: sheets/stripefeed/hub-hydrate all do this rather than widen the seam). */
  async catchUpWithReport(pool: pg.Pool, opts?: ConnectorCatchUpOptions): Promise<BusReplayCatchUpReport> {
    const baseUrl = opts?.baseUrl ?? this.opts.baseUrl;
    const tenantId = this.opts.tenantId ?? DEFAULT_TENANT_ID;
    const batchSize = opts?.limit ?? this.opts.batchSize ?? 100;
    const maxRounds = opts?.maxRounds ?? 10_000;
    const fallback: FallbackPreset = this.opts.fallbackPreset ?? "EARLIEST";

    const report: BusReplayCatchUpReport = { ingested: 0, duplicates: 0, quarantined: 0, gaps: [] };
    let cursor = await this.getCursor(pool, tenantId);

    for (let rounds = 0; ; rounds++) {
      if (rounds >= maxRounds) {
        // A bus that never stops saying has_more (or one so deep it exceeds the budget)
        // must be a LOUD bounded failure: returning normally would report a drain that
        // never finished. Cursor state is consistent — re-run to continue.
        throw new Error(
          `casebus catchUp exceeded maxRounds=${maxRounds} with has_more still true — ` +
            "refusing to report a drain it did not finish; state is consistent, re-run to resume",
        );
      }

      let batch: Batch;
      try {
        batch =
          cursor.replayId === null
            ? await this.fetchBatch(baseUrl, "EARLIEST", null, batchSize)
            : await this.fetchBatch(baseUrl, "CUSTOM", cursor.replayId, batchSize);
      } catch (err) {
        if (err instanceof CorruptedCursorError) {
          // ── the paradigm's data-loss boundary ──────────────────────────────────────
          // The stored replay id names an event the bus has genuinely forgotten.
          // Everything between it and whatever the bus still serves is PERMANENTLY
          // unreachable. Recover in this order: re-establish a subscription (which also
          // tells us the CURRENT stream identity), name the cause from that identity,
          // record the loss with bounds, then keep ingesting.
          const probe = await this.fetchBatch(baseUrl, fallback, null, batchSize);
          const cause: GapCause =
            cursor.streamId !== null && probe.streamId !== null && probe.streamId !== cursor.streamId
              ? "reset"
              : // Unchanged identity ⇒ the window simply moved past us. An UNKNOWN prior
                // identity (a cursor written before migration 010, or by an older build)
                // also lands here: `retention` is the conservative claim, because
                // asserting a reset we cannot evidence would be a fabricated diagnosis.
                "retention";

          const gap = await this.buildGap(pool, tenantId, cursor.replayId, cause, fallback, probe);
          report.gaps.push(gap);
          // FAIL LOUD, deliberately (debt-burn A2 — the WAL rule): the durable loss
          // record is a PRECONDITION for forward progress. If this insert fails, the run
          // fails with the cursor still naming the dead replay id — advancing and exiting
          // 0 would mean a permanent loss whose only durable trace was silently dropped,
          // and the exit code is this system's only alarm channel. Re-running re-detects
          // and re-records (idempotent by (tenant, source, cause, from_event_id)).
          // Pinned in bus-replay.test.ts.
          await recordGap(pool, {
            tenantId,
            source: this.source,
            cause: gap.cause,
            fromEventId: gap.fromEventId,
            fromOccurredAt: gap.fromOccurredAt,
            toEventId: gap.toEventId,
            toOccurredAt: gap.toOccurredAt,
          });

          if (fallback === "LATEST") {
            // The ONE place a server-supplied position is adopted, and only because the
            // operator configured exactly that: LATEST means "abandon the window, be
            // current". Persisting the tip is what makes that intent take effect; without
            // it the next run would re-detect the same dead cursor forever. When the bus
            // retains nothing there is no tip to adopt, so the cursor stays cleared and
            // the next run subscribes fresh.
            if (probe.latestReplayId !== null) {
              await this.setCursor(pool, tenantId, probe.latestReplayId, probe.streamId);
            }
            return report;
          }
          // EARLIEST: re-read the retained window from its start. The re-served events
          // are duplicates, which idempotent ingest absorbs and the report counts.
          cursor = { replayId: null, streamId: probe.streamId };
          continue;
        }
        throw err;
      }

      // Stream order is the bus's own order — but position is never used for anything
      // except "which replay id did we last process". No sorting, no ordinal reasoning.
      let deepest: string | null = null;
      for (const { frame, line } of batch.events) {
        await this.processFrame(pool, tenantId, frame, line, report);
        // Cursor candidate = the last PROCESSED event, including a quarantined one
        // (preserved and replayable), else one poisoned event would wedge the stream on
        // itself forever.
        if (typeof frame.replay_id === "string") deepest = frame.replay_id;
      }

      // Advance only after the WHOLE batch is processed: a crash between batch and cursor
      // write means a re-fetch, i.e. duplicates — which this paradigm produces anyway and
      // idempotent ingest absorbs. Re-delivery is the safe failure mode; skipping is not.
      if (deepest !== null) {
        cursor = { replayId: deepest, streamId: batch.streamId };
        await this.setCursor(pool, tenantId, deepest, batch.streamId);
      }

      if (!batch.hasMore) return report;
      if (batch.events.length === 0) {
        // The structural check reconcile has had since Task D, one screen down: an empty
        // batch carrying has_more:true gives this loop nothing to advance on — it is
        // unterminating by construction. maxRounds would still bound it, but as a slow
        // failure misdiagnosed as depth; name the wedge on the round that shows it
        // (debt-burn A4). Cursor state is untouched — re-run once the bus behaves.
        throw new Error(
          "casebus catchUp: bus reports has_more with an empty batch and no cursor progress — " +
            "structurally unterminating subscription; refusing to spin to maxRounds",
        );
      }
    }
  }

  /**
   * Authoritative comparison of the bus's own retained truth against raw. Independent of
   * the drain's cursor (the seam rule): reconcile reads the WHOLE retained window from
   * EARLIEST, every run, built on nothing catchUp produced.
   */
  async reconcile(
    pool: pg.Pool,
    opts?: ConnectorReconcileOptions,
  ): Promise<ConnectorReconcileResult & { report?: BusReconcileReport }> {
    const baseUrl = opts?.baseUrl ?? this.opts.baseUrl;
    const tenantId = this.opts.tenantId ?? DEFAULT_TENANT_ID;
    const batchSize = this.opts.batchSize ?? 100;
    const RECONCILE_MAX_ROUNDS = 10_000;

    const retained = new Map<string, number>(); // event id → event_time ms
    let currentStreamId: string | null = null;
    try {
      let cursorId: string | null = null;
      for (let rounds = 0; ; rounds++) {
        if (rounds >= RECONCILE_MAX_ROUNDS) {
          return {
            integrity: {
              ok: false,
              detail:
                `bus did not finish serving its retained window within ${RECONCILE_MAX_ROUNDS} batches — ` +
                "has_more never went false; suspect the subscription is re-serving events or its cursor is not advancing",
            },
          };
        }
        const batch: Batch =
          cursorId === null
            ? await this.fetchBatch(baseUrl, "EARLIEST", null, batchSize)
            : await this.fetchBatch(baseUrl, "CUSTOM", cursorId, batchSize);
        currentStreamId = batch.streamId;
        let last: string | null = null;
        for (const { frame } of batch.events) {
          const id = frame.event?.id;
          const t = frame.event?.event_time;
          if (typeof id !== "string" || id === "") {
            // No IDENTITY means nothing to reconcile against: this frame cannot be
            // compared to raw at all, so the window genuinely is unreadable.
            return {
              integrity: { ok: false, detail: `bus served an event frame with no id: ${JSON.stringify(frame).slice(0, 120)}` },
            };
          }
          // An unparseable event_time is NOT an unreadable source (oracle 7 found this
          // hard-failing): the drain already quarantines such an event and keeps going,
          // and the quarantine cross-reference below exists exactly so one poisoned
          // vendor event cannot red every reconcile for the length of the retention
          // window. The event still COUNTS toward the retained window — it is really
          // there — it simply contributes no timestamp, so it is excluded from the
          // aged-out boundary arithmetic rather than corrupting it with NaN.
          const parsed = typeof t === "string" ? Date.parse(t) : NaN;
          retained.set(id, parsed);
          if (typeof frame.replay_id === "string") last = frame.replay_id;
        }
        if (last !== null && last === cursorId) {
          // An honest batch after `replay_id=cursor` excludes the cursor event by
          // definition; seeing it again as the batch's LAST frame means the subscription
          // re-served what we just read, and looping would never terminate.
          return {
            integrity: {
              ok: false,
              detail: `bus is re-serving events: the batch after replay_id=${cursorId} still ends on it — cursor not advancing`,
            },
          };
        }
        if (last !== null) cursorId = last;
        if (!batch.hasMore) break;
        if (batch.events.length === 0) {
          return { integrity: { ok: false, detail: "bus reports has_more with an empty batch and no cursor progress" } };
        }
      }
    } catch (err) {
      return { integrity: { ok: false, detail: `bus unreadable: ${(err as Error).message}` } };
    }

    const rawRes = await pool.query<{ event_id: string; occurred_at: string | null; replay_id: string | null }>(
      `select event_id,
              payload->>'occurred_at' as occurred_at,
              payload->'data'->>'replay_id' as replay_id
         from raw.raw_events
        where tenant_id = $1 and source = $2`,
      [tenantId, this.source],
    );
    const rawIds = new Set(rawRes.rows.map((r) => r.event_id));

    // Quarantine cross-reference (the stripefeed I2 precedent): retained-but-not-in-raw
    // splits into real failures (`missing`) and deliberately-diverted events preserved in
    // ingest.quarantine (`quarantined`, with row counts — re-deliveries accumulate).
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

    // The earliest retained event, by ID as well as by time. Timestamp-bearing events
    // only: a poisoned event_time contributes no boundary (see the reconcile drain above),
    // and a Math.min over NaN would silently poison every aged-out classification.
    // Keeping the ID (cold review I2) is what lets reconcile's own gap detection name the
    // far edge as precisely as catchUp does — it is holding the whole window right here,
    // and filing a null it could have filled made a reconcile-first gap permanently worse
    // than the identical catchUp-first one. Iteration is stream order, so a tie resolves
    // to the first event the bus served — deterministic, and the bus's own ordering.
    let earliestRetained: { id: string; ms: number } | null = null;
    for (const [id, ms] of retained) {
      if (Number.isNaN(ms)) continue;
      if (earliestRetained === null || ms < earliestRetained.ms) earliestRetained = { id, ms };
    }
    const earliestRetainedMs = earliestRetained === null ? null : earliestRetained.ms;
    const extra: string[] = [];
    let agedOutRaw = 0;
    for (const row of rawRes.rows) {
      if (retained.has(row.event_id)) continue;
      const occurredMs = row.occurred_at === null ? NaN : Date.parse(row.occurred_at);
      if (earliestRetainedMs !== null && !Number.isNaN(occurredMs) && occurredMs >= earliestRetainedMs) {
        extra.push(row.event_id);
      } else {
        agedOutRaw++;
      }
    }
    extra.sort();

    // Live gap detection, then the DURABLE read. If the persisted replay id is not in the
    // retained window, the loss is observable right now and worth recording from here too
    // — with the cause derived from the same stream identity the drain would have used.
    const cursor = await this.getCursor(pool, tenantId);
    if (cursor.replayId !== null) {
      // Asked of the BUS, never of raw: raw's copy of a replay id is history (what we
      // once read), not evidence about the source's current window.
      //
      // Transient-vs-permanent classification (debt-burn A1, the AWS SDK retry model):
      // only the vendor's DEFINITIVE rejection (CorruptedCursorError, keyed on the
      // documented error code) is a verdict on the cursor — the probe maps it to
      // stillServed=false and the gap path below. Anything else escaping fetchBatch
      // (timeout, network TypeError, bounded-429 exhaustion — all already bounded per
      // attempt) is TRANSPORT failure: it says nothing about the cursor, so it must not
      // file a gap row (a permanent-loss assertion) and must not throw out of
      // reconcile() past the CLI's standing-loss disclosure for this source and every
      // later one. It becomes integrity:{ok:false} for this source only; a re-run
      // re-probes.
      let stillServed: boolean;
      try {
        stillServed = await this.replayIdIsServed(baseUrl, cursor.replayId, batchSize);
      } catch (err) {
        return {
          integrity: {
            ok: false,
            detail:
              "cursor liveness probe failed — transient bus/transport failure, not a verdict on the " +
              `stored cursor (no gap recorded; re-run reconcile): ${(err as Error).message}`,
          },
        };
      }
      if (!stillServed) {
        const cause: GapCause =
          cursor.streamId !== null && currentStreamId !== null && currentStreamId !== cursor.streamId
            ? "reset"
            : "retention";
        const near = await this.nearEdge(pool, tenantId, cursor.replayId);
        // Same fail-loud rule as catchUp's recordGap (debt-burn A2): a failed insert
        // throws into reconcile's caller — record-before-report, never report-without-record.
        await recordGap(pool, {
          tenantId,
          source: this.source,
          cause,
          fromEventId: near.eventId,
          fromOccurredAt: near.occurredAt,
          // Named, not null (cold review I2): the same fidelity catchUp's buildGap files,
          // so the record does not depend on which surface noticed the loss first.
          toEventId: earliestRetained === null ? null : earliestRetained.id,
          toOccurredAt: earliestRetainedMs === null ? null : new Date(earliestRetainedMs).toISOString(),
        });
      }
    }

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
        gaps: await listGaps(pool, tenantId, this.source),
      },
    };
  }

  // ── the standard door ─────────────────────────────────────────────────────────────────

  /** Frame → door event → unstorable divert → shared schema gate (numeric contract
   *  included) → quarantine failures (never drop) → ingestEvent. The door-count invariant
   *  in event-schema.ts gains its next door here and applies the same predicate.
   *
   *  Poison isolation is BY CONSTRUCTION, not by enumeration (the standing rule, and the
   *  hub-hydrate review-I1 pattern): every frame runs inside its own try/catch, so an
   *  UNEXPECTED throw is quarantined for that frame alone and its batchmates still land. */
  private async processFrame(
    pool: pg.Pool,
    tenantId: string,
    frame: EventFrame,
    line: string,
    report: BusReplayCatchUpReport,
  ): Promise<void> {
    // Vendor frame → door shape. TOTAL: garbage in any position still produces a
    // door-shaped object that flows to the schema gate and quarantines with a named
    // reason — never a throw, never a drop.
    const inner = frame.event ?? {};
    const payload =
      typeof inner.payload === "object" && inner.payload !== null ? (inner.payload as Record<string, unknown>) : {};
    const event: Record<string, unknown> = {
      event_id: typeof inner.id === "string" ? inner.id : (inner.id ?? ""),
      event_type: typeof inner.type === "string" ? inner.type : (inner.type ?? ""),
      // The bus's own event clock (per-source occurred_at normalization, consequence 1).
      occurred_at: inner.event_time,
      // The replay id rides IN the payload deliberately: it is the only durable link from
      // a stored event back to its position in the stream, which is what lets a gap's
      // NEAR EDGE be reconstructed after the event itself has aged off the bus.
      data: { ...payload, replay_id: typeof frame.replay_id === "string" ? frame.replay_id : null },
    };

    try {
      // raw_body custody (2b-D4, disclosed decision): this paradigm stores the GENUINE
      // per-event wire text. The NDJSON framing means the server really did send this
      // exact line for this exact event — unlike the page/batch paradigms, where per-event
      // wire bytes do not exist and honest NULL is the only truthful answer. Quarantined
      // rows carry the same line, for the same reason.
      const unstorable = jsonbUnstorableReason(event);
      if (unstorable !== null) {
        await quarantineEvent(pool, this.source, event, `casebus: ${unstorable}`, line, tenantId);
        report.quarantined++;
        return;
      }
      const parsed = eventSchema.safeParse(event);
      if (!parsed.success) {
        const detail = parsed.error.issues[0];
        const reason = detail
          ? `casebus: schema validation failed: ${detail.path.join(".")} — ${detail.message}`
          : "casebus: schema validation failed";
        await quarantineEvent(pool, this.source, event, reason, line, tenantId);
        report.quarantined++;
        return;
      }
      const result = await ingestEvent(pool, this.source, parsed.data, { tenantId, rawBody: line });
      if (result === "inserted") report.ingested++;
      else report.duplicates++;
    } catch (err) {
      // Unexpected (every KNOWN failure above returns instead of throwing): preserve this
      // frame the same way every other bad frame is preserved, and let its batchmates
      // through. A batch-fatal throw here would lose healthy events to one poisoned one.
      const message = err instanceof Error ? err.message : String(err);
      await quarantineEvent(pool, this.source, event, `casebus: unexpected error processing frame: ${message}`, line, tenantId);
      report.quarantined++;
    }
  }

  // ── gap accounting ────────────────────────────────────────────────────────────────────

  /** Bounds for a freshly-detected gap. Near edge: the last event we verifiably ingested,
   *  recovered from RAW by its stored replay id (the bus itself cannot help — that event
   *  is exactly what it has forgotten). Far edge: the earliest event the fallback
   *  subscription still serves. */
  private async buildGap(
    pool: pg.Pool,
    tenantId: string,
    lostReplayId: string | null,
    cause: GapCause,
    fallback: FallbackPreset,
    probe: Batch,
  ): Promise<BusGap> {
    const near = await this.nearEdge(pool, tenantId, lostReplayId);
    // With LATEST there is deliberately NO knowable far edge: the operator chose to skip
    // whatever the window still held, so the loss runs from the near edge to "now" and
    // claiming a specific event as its far edge would understate it.
    const far = fallback === "LATEST" ? null : (probe.events[0]?.frame.event ?? null);
    return {
      cause,
      fromEventId: near.eventId,
      fromOccurredAt: near.occurredAt,
      toEventId: far !== null && typeof far.id === "string" ? far.id : null,
      toOccurredAt: far !== null && typeof far.event_time === "string" ? far.event_time : null,
    };
  }

  /** The near edge from raw. Null when the lost cursor names no row we hold (e.g. the
   *  event was quarantined — processed, cursor-advanced past, never landed in raw): an
   *  honest "not knowable", never a guess. */
  private async nearEdge(
    pool: pg.Pool,
    tenantId: string,
    replayId: string | null,
  ): Promise<{ eventId: string | null; occurredAt: string | null }> {
    if (replayId === null) return { eventId: null, occurredAt: null };
    const res = await pool.query<{ event_id: string; occurred_at: string | null }>(
      `select event_id, payload->>'occurred_at' as occurred_at
         from raw.raw_events
        where tenant_id = $1 and source = $2 and payload->'data'->>'replay_id' = $3`,
      [tenantId, this.source, replayId],
    );
    return res.rowCount === 0
      ? { eventId: null, occurredAt: null }
      : { eventId: res.rows[0].event_id, occurredAt: res.rows[0].occurred_at };
  }

  /** Does the bus still serve this replay id? A CUSTOM subscribe answers definitively:
   *  the documented corrupted rejection means no. */
  private async replayIdIsServed(baseUrl: string, replayId: string, batchSize: number): Promise<boolean> {
    try {
      await this.fetchBatch(baseUrl, "CUSTOM", replayId, batchSize);
      return true;
    } catch (err) {
      if (err instanceof CorruptedCursorError) return false;
      throw err;
    }
  }

  // ── cursor persistence ────────────────────────────────────────────────────────────────

  // Per (tenant, source) in ingest.cursors. Migration 008 added last_event_id for
  // opaque-id sources and this paradigm REUSES it rather than adding a third cursor
  // column: a replay id is precisely "the opaque id of the last event we processed",
  // which is what that column already means. `last_seq` stays at its ledger-paradigm
  // default of 0 and is never read here — giving it a third, non-ordinal meaning is how
  // cursor columns turn into folklore. Migration 010's `stream_id` is genuinely new
  // information (which STREAM the replay id belongs to), not a second cursor.

  private async getCursor(
    pool: pg.Pool,
    tenantId: string,
  ): Promise<{ replayId: string | null; streamId: string | null }> {
    const res = await pool.query<{ last_event_id: string | null; stream_id: string | null }>(
      "select last_event_id, stream_id from ingest.cursors where tenant_id = $1 and source = $2",
      [tenantId, this.source],
    );
    return res.rowCount === 0
      ? { replayId: null, streamId: null }
      : { replayId: res.rows[0].last_event_id, streamId: res.rows[0].stream_id };
  }

  private async setCursor(
    pool: pg.Pool,
    tenantId: string,
    replayId: string,
    streamId: string | null,
  ): Promise<void> {
    await pool.query(
      `insert into ingest.cursors (tenant_id, source, last_seq, last_event_id, stream_id, updated_at)
       values ($1, $2, 0, $3, $4, now())
       on conflict (tenant_id, source) do update
         set last_event_id = excluded.last_event_id,
             stream_id = coalesce(excluded.stream_id, ingest.cursors.stream_id),
             updated_at = now()`,
      [tenantId, this.source, replayId, streamId],
    );
  }

  // ── fetch discipline ──────────────────────────────────────────────────────────────────

  /** One subscribe. Register L1-G4 paid: per-attempt AbortSignal.timeout. On 429, the
   *  house truncated exponential backoff with DETERMINISTIC jitter (Knuth multiplicative
   *  hash of the attempt index — reproducible traces; ingest must not import the mocks'
   *  prng), bounded attempts, then a loud failure. The documented corrupted-replay-id
   *  rejection maps to CorruptedCursorError; every other non-ok response throws. */
  private async fetchBatch(
    baseUrl: string,
    preset: "EARLIEST" | "LATEST" | "CUSTOM",
    replayId: string | null,
    numRequested: number,
  ): Promise<Batch> {
    const timeoutMs = this.opts.timeoutMs ?? 5000;
    const { baseMs = 100, capMs = 2000, maxAttempts = 6 } = this.opts.backoff ?? {};
    const url =
      `${baseUrl}/subscribe?replay_preset=${preset}&num_requested=${numRequested}` +
      (preset === "CUSTOM" && replayId !== null ? `&replay_id=${encodeURIComponent(replayId)}` : "");

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        if ((err as Error).name === "TimeoutError") {
          throw new Error(`casebus subscribe timed out after ${timeoutMs}ms: GET ${url}`);
        }
        throw new Error(`casebus subscribe failed: GET ${url}: ${(err as Error).message}`);
      }

      if (res.status === 429) {
        await res.text().catch(() => undefined); // release the socket before sleeping
        if (attempt < maxAttempts - 1) {
          const jitter = (Math.imul(attempt + 1, 0x9e3779b1) >>> 0) / 2 ** 32;
          await sleep(Math.min(baseMs * 2 ** attempt + jitter * baseMs, capMs));
          continue;
        }
        throw new Error(`casebus rate-limited: GET ${url} answered 429 through ${maxAttempts} bounded attempts`);
      }

      const text = await res.text();

      if (res.status === 400) {
        // Structurally match the researched rejection: the error object carries the gRPC
        // status name and the vendor's own error CODE. We key on the code, never on the
        // HTTP number — the number is this HTTP/JSON translation's artifact, the code is
        // the vendor's contract. Anything else 400-shaped is OUR bug or a contract drift
        // and must stay loud, never be absorbed as data loss.
        let code: string | undefined;
        try {
          code = (JSON.parse(text) as { error?: { code?: string } }).error?.code;
        } catch {
          /* unparseable 400 body → generic loud failure below */
        }
        if (code === "sfdc.platform.eventbus.grpc.subscription.fetch.replayid.corrupted") {
          throw new CorruptedCursorError(replayId ?? "(none)");
        }
      }
      if (!res.ok) {
        throw new Error(`casebus subscribe failed: GET ${url} returned status ${res.status}`);
      }

      // NDJSON: event frames, then exactly one trailing status frame (the HTTP/JSON
      // translation of the gRPC trailer). The status frame is what makes has_more the
      // ONLY termination signal — batch emptiness and batch size infer nothing.
      const lines = text.split("\n").filter((l) => l.length > 0);
      const events: { frame: EventFrame; line: string }[] = [];
      let status: { stream_id?: unknown; has_more?: unknown; latest_replay_id?: unknown } | null = null;
      for (const line of lines) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          throw new Error(`casebus frame unparseable: GET ${url} returned a non-JSON line`);
        }
        if (parsed.status !== undefined) {
          status = parsed.status as { stream_id?: unknown; has_more?: unknown; latest_replay_id?: unknown };
        } else {
          events.push({ frame: parsed as EventFrame, line });
        }
      }
      if (status === null || typeof status.has_more !== "boolean") {
        throw new Error(`casebus response malformed: GET ${url} carried no trailing status frame with has_more`);
      }
      return {
        events,
        hasMore: status.has_more,
        streamId: typeof status.stream_id === "string" ? status.stream_id : null,
        latestReplayId: typeof status.latest_replay_id === "string" ? status.latest_replay_id : null,
      };
    }
    // Unreachable: every loop path returns or throws; TypeScript cannot see that.
    throw new Error(`casebus subscribe failed: GET ${url} exhausted ${maxAttempts} attempts`);
  }
}
