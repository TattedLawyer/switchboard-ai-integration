// The hub-hydrate connector (Phase 2b Task C): a HubSpot-STYLE thin-webhook CRM source.
//
// Contract (phase plan §2, research-verified): webhook payloads are METADATA-ONLY —
// `objectId`, `propertyName`/`propertyValue` only on property-change subscriptions,
// `eventId`, `subscriptionType`, `portalId`, `occurredAt` ms-epoch, `attemptNumber`
// from 0, `changeSource`; up to 100 events per request; ordering NOT guaranteed
// (sequence by occurredAt — staging's occurred_at-wins, never delivery order);
// 10 retries over 24h, then the webhook is GONE.
//
// The paradigm's three truths, kept deliberately apart (D7, spec-locked):
//   1. RAW holds the thin event EXACTLY as received — vendor vocabulary, ms epoch,
//      sparse fields, explicit nulls. Nothing enriched in place, ever.
//   2. ingest.hydrated_snapshots holds the FETCHED full record per event, stamped with
//      fetch time — fetch-TIME state, which can already be newer than the event that
//      triggered the fetch (the notify→fetch race is a fact of the paradigm, stored
//      honestly, sequenced downstream by occurred_at). Deleted-before-fetch → 404 →
//      tombstone row. Hydrated records are STILL VENDOR DATA: the field contract
//      applies to them, and a failing snapshot is quarantined + dead-lettered —
//      visible, never silently stored.
//   3. The vendor's OBJECT STORE is the reconcile truth. Webhooks are lossy on their
//      own terms (10-retries-then-gone); reconcile() reads the store directly and
//      names each loss class: `missing` (objects we never heard of), `drifted` (the
//      store moved and no webhook told us — latest snapshot ≠ current state), `extra`
//      (raw knows an object the store lacks with no deletion event to explain it).
//
// The second oracle (pinned in hub-oracle.test.ts): after a hydration run, every thin
// event in raw is in EXACTLY one terminal state — snapshot, tombstone, or the hydration
// DLQ (pg-boss queue `hydrate-hubcrm-dlq`, the per-source pattern). Nothing in limbo.

import { PgBoss } from "pg-boss";
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
import { numericContractViolation } from "../numeric-contract.js";

/** The source literal (registered in SOURCES — deployment surface: HUBCRM_BASE_URL,
 *  port 4007, INGEST_SOURCES opt-in). One spelling, shared by registry and connector. */
export const HUBCRM_SOURCE = "hubcrm" as const;

/** The hydration dead-letter queue (per-source pattern: one DLQ per source's failure
 *  lane). Jobs here are TERMINAL records, not work items: the pump never re-fetches a
 *  DLQ'd event; replay is a deliberate operator act (register follow-up). */
export const HYDRATE_DLQ = "hydrate-hubcrm-dlq";

const HUB_OBJECT_TYPES = ["company", "contact", "deal"] as const;
type HubObjectType = (typeof HUB_OBJECT_TYPES)[number];

// ── the batch door (Task C disclosed decision) ─────────────────────────────────────────
//
// The generic webhook door (server.ts) keeps its shared machinery — media-type gate,
// raw-body capture, HMAC over the whole request — and hands a verified hubcrm request
// HERE, so vendor knowledge lives in the connector module, not the door. The batch is
// split and each element runs the EXISTING per-event pipeline: vendor→door mapping →
// unstorable divert → shared schema gate (numeric contract included) → per-event
// quarantine or ingest. BATCH-FATAL IS FORBIDDEN (the register's STANDING RULE): one
// bad element quarantines alone; its batchmates land. That is enforced BY CONSTRUCTION,
// not by enumerating the failures we thought of: every element runs inside its own
// try/catch, so an UNEXPECTED throw (transient DB error, an unstorable class the
// predicate does not yet recognize) is quarantined-or-counted for that element and the
// loop continues (review finding I1).

/** Vendor thin event → door shape. TOTAL: garbage in any position still produces a
 *  door-shaped object that flows to the schema gate and quarantines with a named
 *  reason — never a throw, never a drop. The vendor event rides under `data` VERBATIM
 *  (D7); occurred_at is the ms-epoch `occurredAt` ISO-rendered (per-source occurred_at
 *  normalization, consequence 1) — the original ms value stays in data. A non-finite /
 *  non-numeric `occurredAt` normalizes to NULL rather than passing arbitrary vendor JSON
 *  into the timestamp position (review M1); the outcome is unchanged — the schema gate
 *  quarantines it with a reason naming occurred_at — but only one shape reaches it. */
export function mapThinEvent(item: unknown): Record<string, unknown> {
  const o = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
  const occurred = o.occurredAt;
  return {
    event_id: o.eventId === undefined || o.eventId === null ? "" : String(o.eventId),
    event_type: typeof o.subscriptionType === "string" ? o.subscriptionType : "",
    occurred_at:
      typeof occurred === "number" && Number.isFinite(occurred) ? new Date(occurred).toISOString() : null,
    data: o,
  };
}

export interface HubBatchOutcome {
  status: number;
  body:
    | {
        stored: number;
        duplicates: number;
        quarantined: number;
        /** Elements whose processing threw AND whose quarantine write also failed — so
         *  they are in no bucket at all. Reported (and logged) rather than folded into
         *  `quarantined`, which would claim a custody that does not exist. Omitted when
         *  zero so the healthy response shape is unchanged. */
        failed?: number;
      }
    | { error: string };
}

export async function handleHubcrmBatch(
  pool: pg.Pool,
  body: unknown,
  // The exact request text (signature-verified by the door). Disclosed raw_body
  // decision: the BATCH is the wire unit — per-event wire bytes do not exist, and a
  // re-serialization passed off as custody is forbidden (stripefeed precedent). So
  // ingested rows store raw_body NULL, and quarantined-unstorable rows carry the FULL
  // batch text: wider than the event, but byte-exact, and preservation is the point
  // exactly there.
  rawBody: string,
  tenantId: string = DEFAULT_TENANT_ID,
): Promise<HubBatchOutcome> {
  if (!Array.isArray(body)) {
    return {
      status: 400,
      body: { error: "hubcrm delivers batches: the request body must be a JSON array of thin events" },
    };
  }
  let stored = 0;
  let duplicates = 0;
  let quarantined = 0;
  let failed = 0;
  for (const item of body) {
    try {
      const event = mapThinEvent(item);
      const unstorable = jsonbUnstorableReason(event);
      if (unstorable !== null) {
        await quarantineEvent(pool, HUBCRM_SOURCE, event, `hubcrm: ${unstorable} (raw_body holds the full batch)`, rawBody, tenantId);
        quarantined++;
        continue;
      }
      const parsed = eventSchema.safeParse(event);
      if (!parsed.success) {
        const detail = parsed.error.issues[0];
        const reason = detail
          ? `schema validation failed: ${detail.path.join(".")} — ${detail.message}`
          : "schema validation failed";
        await quarantineEvent(pool, HUBCRM_SOURCE, event, reason, undefined, tenantId);
        quarantined++;
        continue;
      }
      const result = await ingestEvent(pool, HUBCRM_SOURCE, parsed.data, { tenantId });
      if (result === "inserted") stored++;
      else duplicates++;
    } catch (err) {
      // The construction that makes batch-fatal impossible. Anything that throws here is
      // by definition unexpected (every KNOWN failure above returns a reason instead), so
      // the element is preserved the same way every other bad element is — quarantine
      // with a reason naming the throw — and the loop moves on to its batchmates.
      const message = err instanceof Error ? err.message : String(err);
      try {
        await quarantineEvent(
          pool,
          HUBCRM_SOURCE,
          mapThinEvent(item),
          `hubcrm: unexpected error processing batch element: ${message} (raw_body holds the full batch)`,
          rawBody,
          tenantId,
        );
        quarantined++;
      } catch (quarantineErr) {
        // Custody itself failed (the database is the thing that is broken). We refuse to
        // count this as quarantined — that would claim a custody we do not have — so it
        // is counted as `failed`, logged on the gap channel, AND answered non-2xx below.
        // The non-2xx is what actually saves the element: HubSpot retries only on
        // non-2xx (10 attempts over 24h), so a 202 here would acknowledge an element
        // that reached NO bucket — not raw, not quarantine, not the DLQ — and nothing
        // would ever retry it. Redelivered batchmates are idempotent duplicates by the
        // per-element mechanism above, so re-answering the whole batch costs nothing.
        failed++;
        console.error(
          JSON.stringify({
            source: HUBCRM_SOURCE,
            event: "batch_element_unrecoverable",
            message,
            quarantineError: quarantineErr instanceof Error ? quarantineErr.message : String(quarantineErr),
          }),
        );
      }
    }
  }
  // 202 only when every element reached a bucket. An element counted `failed` reached
  // none, so the batch must NOT be acknowledged — see the custody-failure comment above.
  return {
    status: failed > 0 ? 500 : 202,
    body: { stored, duplicates, quarantined, ...(failed > 0 ? { failed } : {}) },
  };
}

// ── the connector ──────────────────────────────────────────────────────────────────────

export interface HubHydrateConnectorOptions {
  /** Base URL of the vendor API (GET <baseUrl>/objects/<type>[/<id>]). */
  baseUrl: string;
  tenantId?: string;
  /** Per-request AbortSignal.timeout (L1-G4 discipline). Default 5000ms. */
  timeoutMs?: number;
  /** Truncated exponential backoff for 429/5xx: bounded attempts with deterministic
   *  jitter (house pattern), then the hydration DLQ. */
  backoff?: { baseMs?: number; capMs?: number; maxAttempts?: number };
  /** Rate budget: max events hydrated per run (the researched limits pattern — HubSpot
   *  buckets requests per 10s window; a pump that fetches unboundedly would eat the
   *  whole app's budget). Events beyond it stay PENDING — counted, printed, and picked
   *  up next run. Default 500. */
  fetchBudget?: number;
  /** Connection string for the pg-boss DLQ (defaults to DATABASE_URL). */
  databaseUrl?: string;
}

export interface HydrationDlqEntry {
  event_id: string;
  object_type: string;
  object_id: string;
  reason: string;
}

/** catchUpWithReport's shape (widening-method house pattern). `ingested`/`duplicates`
 *  are structurally present for the shared CatchUpReport surface and always 0: thin
 *  events arrive by webhook PUSH — this paradigm's catchUp is the hydration pump, and
 *  saying it "ingested" anything would be the dishonesty the integrity lines exist to
 *  prevent. `quarantined` counts snapshots that failed the vendor-data contract. */
export interface HubHydrationReport {
  ingested: number;
  duplicates: number;
  quarantined: number;
  hydrated: number;
  tombstoned: number;
  hydrationDlq: number;
  hydrationPending: number;
}

/** Seam-report semantics for the object-store paradigm: `ledger` = objects currently in
 *  the store (the ledger-equivalent), `raw` = distinct thin events in raw. missing /
 *  extra carry `<type>:<objectId>` keys (this paradigm reconciles OBJECTS, not event
 *  ids — the CLI labels them as such). */
export interface HubReconcileReport extends ReconcileReport {
  /** Live store objects whose LATEST hydrated snapshot no longer matches the store —
   *  the store moved and no webhook told us. Objects whose latest event is DLQ'd are
   *  excluded (already visible in hydrationDlq; double-flagging would make one poison
   *  object a permanent double-red). */
  drifted: string[];
  /** Objects absent from the store WITH a deletion event in raw — normal metabolism. */
  tombstonedRaw: number;
  /** Thin events with no terminal hydration state yet (budget spillover). */
  hydrationPending: number;
  hydrationDlq: HydrationDlqEntry[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type FetchOutcome =
  | { kind: "ok"; body: unknown }
  | { kind: "gone" }
  | { kind: "failed"; reason: string };

interface RawThinRow {
  event_id: string;
  event_type: string;
  payload: { occurred_at?: string; data?: Record<string, unknown> };
  received_at: string;
}

function objectRefOf(row: RawThinRow): { objectType: HubObjectType; objectId: string } | null {
  const type = String(row.event_type ?? "").split(".")[0];
  const id = row.payload?.data?.objectId;
  if (
    (HUB_OBJECT_TYPES as readonly string[]).includes(type) &&
    (typeof id === "number" || (typeof id === "string" && id !== ""))
  ) {
    return { objectType: type as HubObjectType, objectId: String(id) };
  }
  return null;
}

/** Canonical JSON (sorted keys) for drift comparison: jsonb re-orders object keys, so a
 *  byte compare of parsed objects must not depend on key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export class HubHydrateConnector implements Connector {
  readonly kind = "hub-hydrate" as const;
  readonly source = HUBCRM_SOURCE;

  constructor(private readonly opts: HubHydrateConnectorOptions) {}

  async catchUp(pool: pg.Pool, opts?: ConnectorCatchUpOptions): Promise<number> {
    const report = await this.catchUpWithReport(pool, opts);
    // The seam's "events newly ingested" number, translated honestly: progress here is
    // hydration progress (snapshots + tombstones written), never raw ingestion.
    return report.hydrated + report.tombstoned;
  }

  /** The hydration pump. Scans raw for thin events with no terminal state, fetches each
   *  one's object (no cache — every snapshot row's fetched_at must be a real fetch, not
   *  a shared one), and lands every scanned event in exactly one of: snapshot row,
   *  tombstone row, hydration DLQ — or counts it PENDING when the rate budget ran out. */
  async catchUpWithReport(pool: pg.Pool, opts?: ConnectorCatchUpOptions): Promise<HubHydrationReport> {
    const baseUrl = opts?.baseUrl ?? this.opts.baseUrl;
    const tenantId = this.opts.tenantId ?? DEFAULT_TENANT_ID;
    const budget = this.opts.fetchBudget ?? 500;

    const report: HubHydrationReport = {
      ingested: 0,
      duplicates: 0,
      quarantined: 0,
      hydrated: 0,
      tombstoned: 0,
      hydrationDlq: 0,
      hydrationPending: 0,
    };

    const pending = await pool.query<RawThinRow>(
      `select r.event_id, r.event_type, r.payload, r.received_at
         from raw.raw_events r
        where r.tenant_id = $1 and r.source = $2
          and not exists (
            select 1 from ingest.hydrated_snapshots s
             where s.tenant_id = r.tenant_id and s.event_id = r.event_id
          )
        order by r.received_at, r.event_id`,
      [tenantId, this.source],
    );
    if (pending.rowCount === 0) return report;

    return await this.withBoss(async (boss) => {
      const dlqIds = await this.dlqEventIds(boss);
      let spent = 0;
      for (const row of pending.rows) {
        if (dlqIds.has(row.event_id)) continue; // terminal — replay is an operator act
        const ref = objectRefOf(row);
        if (ref === null) {
          // Un-hydratable shape: it passed the door contract (or predates it), but names
          // no object. Terminal, visible, preserved — never silently skipped.
          await this.dlqSend(boss, {
            event_id: row.event_id,
            object_type: "unknown",
            object_id: "unknown",
            reason: "thin event names no hydratable object (no objectId / unknown subscriptionType)",
          });
          report.hydrationDlq++;
          continue;
        }
        if (spent >= budget) {
          report.hydrationPending++;
          continue;
        }
        spent++;
        const outcome = await this.fetchObject(baseUrl, ref.objectType, ref.objectId);
        if (outcome.kind === "gone") {
          await pool.query(
            `insert into ingest.hydrated_snapshots (tenant_id, event_id, object_type, object_id, snapshot, tombstone)
             values ($1, $2, $3, $4, null, true) on conflict (tenant_id, event_id) do nothing`,
            [tenantId, row.event_id, ref.objectType, ref.objectId],
          );
          report.tombstoned++;
          continue;
        }
        if (outcome.kind === "failed") {
          await this.dlqSend(boss, {
            event_id: row.event_id,
            object_type: ref.objectType,
            object_id: ref.objectId,
            reason: outcome.reason,
          });
          report.hydrationDlq++;
          continue;
        }
        // A hydrated record is vendor data: the field contract applies before storage.
        const snapshot = outcome.body as { properties?: unknown };
        const props =
          typeof snapshot === "object" && snapshot !== null && typeof snapshot.properties === "object" && snapshot.properties !== null
            ? (snapshot.properties as Record<string, unknown>)
            : null;
        const violation =
          props === null
            ? { field: "properties", reason: "snapshot carries no properties object" }
            : numericContractViolation(`hubcrm.${ref.objectType}.snapshot`, props);
        if (violation !== null) {
          // Visible, twice over (disclosed decision): the garbage snapshot is PRESERVED
          // in quarantine with a reason naming the field (custody + the replay CLI's
          // listing), and the event's hydration state goes TERMINAL in the DLQ so the
          // trichotomy holds and the pump stops re-fetching a record the vendor keeps
          // serving broken. Silently storing it was the one forbidden path.
          await quarantineEvent(
            pool,
            this.source,
            { event_id: row.event_id, object_type: ref.objectType, object_id: ref.objectId, snapshot },
            `hubcrm hydration: snapshot failed contract: ${violation.reason}`,
            undefined,
            tenantId,
          );
          await this.dlqSend(boss, {
            event_id: row.event_id,
            object_type: ref.objectType,
            object_id: ref.objectId,
            reason: `snapshot failed contract: ${violation.reason}`,
          });
          report.quarantined++;
          report.hydrationDlq++;
          continue;
        }
        await pool.query(
          `insert into ingest.hydrated_snapshots (tenant_id, event_id, object_type, object_id, snapshot, tombstone)
           values ($1, $2, $3, $4, $5, false) on conflict (tenant_id, event_id) do nothing`,
          [tenantId, row.event_id, ref.objectType, ref.objectId, JSON.stringify(snapshot)],
        );
        report.hydrated++;
      }
      return report;
    });
  }

  /**
   * Authoritative comparison of the vendor object store's CURRENT truth against raw +
   * snapshots. Seam rule: built on the store's own listings, never on anything the push
   * path produced — the buckets are derived fresh every run.
   */
  async reconcile(
    pool: pg.Pool,
    opts?: ConnectorReconcileOptions,
  ): Promise<ConnectorReconcileResult & { report?: HubReconcileReport }> {
    const baseUrl = opts?.baseUrl ?? this.opts.baseUrl;
    const tenantId = this.opts.tenantId ?? DEFAULT_TENANT_ID;

    // 1. The store's truth, all three types. Unreadable store = no report (comparing
    // against a truth we could not read would produce confident, meaningless diffs).
    const storeObjects = new Map<string, Record<string, unknown>>();
    for (const type of HUB_OBJECT_TYPES) {
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/objects/${type}`, { signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000) });
      } catch (err) {
        return { integrity: { ok: false, detail: `object store unreadable: GET /objects/${type}: ${(err as Error).message}` } };
      }
      if (!res.ok) {
        return { integrity: { ok: false, detail: `object store unreadable: GET /objects/${type} answered ${res.status}` } };
      }
      let body: { results?: unknown };
      try {
        body = (await res.json()) as { results?: unknown };
      } catch {
        return { integrity: { ok: false, detail: `object store listing unparseable: GET /objects/${type}` } };
      }
      if (!Array.isArray(body.results)) {
        return { integrity: { ok: false, detail: `object store listing malformed: GET /objects/${type} lacks results[]` } };
      }
      for (const item of body.results) {
        const o = item as { objectId?: unknown; properties?: unknown };
        if (o.objectId === undefined || typeof o.properties !== "object" || o.properties === null) {
          return { integrity: { ok: false, detail: `object store served a malformed ${type} record` } };
        }
        storeObjects.set(`${type}:${String(o.objectId)}`, o.properties as Record<string, unknown>);
      }
    }

    // 2. Raw thin events, grouped per object; deletion events remembered per object.
    const rawRes = await pool.query<RawThinRow>(
      `select event_id, event_type, payload, received_at
         from raw.raw_events
        where tenant_id = $1 and source = $2`,
      [tenantId, this.source],
    );
    interface ObjEvents {
      latest: { event_id: string; occurredMs: number; received_at: string } | null;
      deletionSeen: boolean;
    }
    const rawByObject = new Map<string, ObjEvents>();
    for (const row of rawRes.rows) {
      const ref = objectRefOf(row);
      if (ref === null) continue; // un-hydratable shapes live in the DLQ listing
      const key = `${ref.objectType}:${ref.objectId}`;
      const entry = rawByObject.get(key) ?? { latest: null, deletionSeen: false };
      if (row.event_type.endsWith(".deletion")) entry.deletionSeen = true;
      const occurredMs =
        typeof row.payload?.data?.occurredAt === "number"
          ? row.payload.data.occurredAt
          : Date.parse(String(row.payload?.occurred_at ?? ""));
      const candidate = { event_id: row.event_id, occurredMs, received_at: row.received_at };
      // Latest per object mirrors the staging successor: occurred desc, received desc,
      // event_id desc.
      const cur = entry.latest;
      if (
        cur === null ||
        candidate.occurredMs > cur.occurredMs ||
        (candidate.occurredMs === cur.occurredMs &&
          (candidate.received_at > cur.received_at ||
            (candidate.received_at === cur.received_at && candidate.event_id > cur.event_id)))
      ) {
        entry.latest = candidate;
      }
      rawByObject.set(key, entry);
    }

    // 3. Snapshots + DLQ.
    const snapRes = await pool.query<{ event_id: string; snapshot: { properties?: unknown } | null; tombstone: boolean }>(
      "select event_id, snapshot, tombstone from ingest.hydrated_snapshots where tenant_id = $1",
      [tenantId],
    );
    const snapByEvent = new Map(snapRes.rows.map((r) => [r.event_id, r]));
    const dlqEntries = await this.withBoss(async (boss) => this.dlqList(boss));
    const dlqIds = new Set(dlqEntries.map((d) => d.event_id));

    // 4. Buckets.
    const missing: string[] = [];
    const drifted: string[] = [];
    const extra: string[] = [];
    let tombstonedRaw = 0;
    let hydrationPending = 0;
    for (const row of rawRes.rows) {
      if (!snapByEvent.has(row.event_id) && !dlqIds.has(row.event_id)) hydrationPending++;
    }
    for (const [key, entry] of rawByObject) {
      if (!storeObjects.has(key)) {
        if (entry.deletionSeen) tombstonedRaw++;
        else extra.push(key);
      }
    }
    for (const [key, props] of storeObjects) {
      const entry = rawByObject.get(key);
      if (entry === undefined || entry.latest === null) {
        missing.push(key); // the store has it; no webhook ever told us — permanent-loss class
        continue;
      }
      if (dlqIds.has(entry.latest.event_id)) continue; // visible in the DLQ listing already
      const snap = snapByEvent.get(entry.latest.event_id);
      if (snap === undefined) continue; // pending — counted above, resolves next pump
      if (snap.tombstone) {
        drifted.push(key); // hydration saw 404, yet the store serves it now — drift either way
        continue;
      }
      const snapProps =
        typeof snap.snapshot === "object" && snap.snapshot !== null ? snap.snapshot.properties : undefined;
      if (canonical(snapProps) !== canonical(props)) drifted.push(key);
    }
    missing.sort();
    extra.sort();
    drifted.sort();

    return {
      integrity: { ok: true },
      report: {
        ledger: storeObjects.size,
        raw: rawRes.rowCount ?? 0,
        missing,
        extra,
        rawDuplicates: 0, // structurally impossible: uq (tenant_id, source, event_id)
        drifted,
        tombstonedRaw,
        hydrationPending,
        hydrationDlq: dlqEntries,
      },
    };
  }

  // ── fetch discipline ──────────────────────────────────────────────────────────────────

  /** GET one object. 404 = gone (a terminal answer, not a failure); 429/5xx and network
   *  errors retry with truncated exponential backoff + deterministic jitter (Knuth hash
   *  of the attempt index — reproducible traces, house pattern), bounded attempts; any
   *  other non-ok is a non-retryable failure. Exhaustion reports the LAST reason. */
  private async fetchObject(baseUrl: string, objectType: string, objectId: string): Promise<FetchOutcome> {
    const timeoutMs = this.opts.timeoutMs ?? 5000;
    const { baseMs = 100, capMs = 2000, maxAttempts = 6 } = this.opts.backoff ?? {};
    const url = `${baseUrl}/objects/${objectType}/${encodeURIComponent(objectId)}`;
    let lastReason = "no attempt made";
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const jitter = (Math.imul(attempt, 0x9e3779b1) >>> 0) / 2 ** 32;
        await sleep(Math.min(baseMs * 2 ** (attempt - 1) + jitter * baseMs, capMs));
      }
      let res: Response;
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        lastReason =
          (err as Error).name === "TimeoutError"
            ? `GET ${url} timed out after ${timeoutMs}ms`
            : `GET ${url} failed: ${(err as Error).message}`;
        continue;
      }
      if (res.status === 404) {
        await res.text().catch(() => undefined);
        return { kind: "gone" };
      }
      if (res.status === 429 || res.status >= 500) {
        await res.text().catch(() => undefined);
        lastReason = `GET ${url} answered ${res.status}`;
        continue;
      }
      if (!res.ok) {
        await res.text().catch(() => undefined);
        return { kind: "failed", reason: `GET ${url} answered ${res.status} — not a retryable class` };
      }
      try {
        return { kind: "ok", body: await res.json() };
      } catch {
        return { kind: "failed", reason: `GET ${url} returned non-JSON` };
      }
    }
    return { kind: "failed", reason: `hydration exhausted ${maxAttempts} attempts — last: ${lastReason}` };
  }

  // ── the hydration DLQ (pg-boss, per-source pattern) ───────────────────────────────────

  /** One boss per run, stopped in finally — the replay-CLI precedent. The DLQ is a
   *  durable dead-letter STORE (send + findJobs), never worked by a consumer. */
  private async withBoss<T>(fn: (boss: PgBoss) => Promise<T>): Promise<T> {
    const connectionString = this.opts.databaseUrl ?? process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("hub-hydrate needs a database url for its hydration DLQ (databaseUrl option or DATABASE_URL)");
    }
    const boss = new PgBoss({ connectionString });
    boss.on("error", (err) => {
      console.error(JSON.stringify({ pgboss: "error", message: err instanceof Error ? err.message : String(err) }));
    });
    await boss.start();
    try {
      await boss.createQueue(HYDRATE_DLQ, {});
      return await fn(boss);
    } finally {
      await boss.stop();
    }
  }

  private async dlqSend(boss: PgBoss, entry: HydrationDlqEntry): Promise<void> {
    // singletonKey = event_id: one terminal record per event, even across racing pumps.
    await boss.send(HYDRATE_DLQ, entry, { singletonKey: entry.event_id });
  }

  private async dlqList(boss: PgBoss): Promise<HydrationDlqEntry[]> {
    const jobs = await boss.findJobs<HydrationDlqEntry>(HYDRATE_DLQ);
    // Same state reading as fetchDlq (queue.ts): a never-worked queue's live jobs sit in
    // 'created' (or 'retry' after a replay tool touches them).
    return jobs
      .filter((j) => j.state === "created" || j.state === "retry")
      .map((j) => j.data)
      .sort((a, b) => a.event_id.localeCompare(b.event_id));
  }

  private async dlqEventIds(boss: PgBoss): Promise<Set<string>> {
    return new Set((await this.dlqList(boss)).map((d) => d.event_id));
  }
}
