import type pg from "pg";

// F-1c shared fixture helper: the hubcrm-sourced warehouse reads TWO tables — the thin
// event in raw.raw_events (metadata only; its occurred_at/received_at/event_id are the
// successor-ordering clocks) and the fetched full record in ingest.hydrated_snapshots
// (keyed by the triggering event). Staging fixtures must therefore write both, exactly
// as the pump does, or they test a universe the models cannot see. One helper, used by
// every suite that seeds hubcrm-shaped state, so the two-table invariant cannot drift
// per test file.

export interface HubObjectStateInput {
  objectType: "company" | "contact" | "deal";
  objectId: string | number;
  eventId: string;
  /** ISO-8601 — the thin event's normalized occurred_at (the vendor's own clock). */
  occurredAt: string;
  /** Defaults to now() when omitted. */
  receivedAt?: string;
  /** hubcrm subscriptionType; defaults to `<objectType>.creation`. */
  eventType?: string;
  /** The fetched record's vendor-faithful string properties. Ignored for tombstones. */
  properties?: Record<string, string | null>;
  /** true = the fetch answered 404 (deleted-before-fetch / consumed by a merge). */
  tombstone?: boolean;
  /** true = write ONLY the snapshot row: the triggering raw event already exists (e.g.
   *  a merge event inserted via insertHubMergeEvent — the pump keys the survivor's
   *  snapshot by that same event id). */
  skipRawEvent?: boolean;
}

/** Insert one thin event + its terminal hydration state (snapshot or tombstone). */
export async function insertHubObjectState(pool: pg.Pool, s: HubObjectStateInput): Promise<void> {
  const eventType = s.eventType ?? `${s.objectType}.creation`;
  if (!s.skipRawEvent) await pool.query(
    `insert into raw.raw_events (source, event_id, event_type, payload${s.receivedAt ? ", received_at" : ""})
     values ('hubcrm', $1, $2, $3::jsonb${s.receivedAt ? ", $4" : ""})`,
    [
      s.eventId,
      eventType,
      JSON.stringify({
        event_id: s.eventId,
        event_type: eventType,
        occurred_at: s.occurredAt,
        data: { eventId: s.eventId, subscriptionType: eventType, objectId: s.objectId },
      }),
      ...(s.receivedAt ? [s.receivedAt] : []),
    ],
  );
  if (s.tombstone) {
    await pool.query(
      `insert into ingest.hydrated_snapshots (event_id, object_type, object_id, snapshot, tombstone)
       values ($1, $2, $3, null, true)`,
      [s.eventId, s.objectType, String(s.objectId)],
    );
  } else {
    await pool.query(
      `insert into ingest.hydrated_snapshots (event_id, object_type, object_id, snapshot, tombstone)
       values ($1, $2, $3, $4::jsonb, false)`,
      [
        s.eventId,
        s.objectType,
        String(s.objectId),
        JSON.stringify({
          objectId: typeof s.objectId === "string" ? Number(s.objectId) || s.objectId : s.objectId,
          objectType: s.objectType,
          archived: false,
          properties: s.properties ?? {},
        }),
      ],
    );
  }
}

export interface HubMergeEventInput {
  eventId: string;
  occurredAt: string;
  receivedAt?: string;
  primaryObjectId: string | number;
  mergedObjectIds: Array<string | number>;
  newObjectId: string | number;
}

/** Insert a company.merge thin event (raw only — the survivor's snapshot rides its own
 *  insertHubObjectState call, exactly as the pump hydrates the merge event's objectId). */
export async function insertHubMergeEvent(pool: pg.Pool, m: HubMergeEventInput): Promise<void> {
  await pool.query(
    `insert into raw.raw_events (source, event_id, event_type, payload${m.receivedAt ? ", received_at" : ""})
     values ('hubcrm', $1, 'company.merge', $2::jsonb${m.receivedAt ? ", $3" : ""})`,
    [
      m.eventId,
      JSON.stringify({
        event_id: m.eventId,
        event_type: "company.merge",
        occurred_at: m.occurredAt,
        data: {
          eventId: m.eventId,
          subscriptionType: "company.merge",
          objectId: m.newObjectId,
          primaryObjectId: m.primaryObjectId,
          mergedObjectIds: m.mergedObjectIds,
          newObjectId: m.newObjectId,
        },
      }),
      ...(m.receivedAt ? [m.receivedAt] : []),
    ],
  );
}

/** Casebus-shaped raw insert: the bus connector's door shape — event_id is the event's
 *  own uuid-ish identity, occurred_at the event_time, payload.data the case payload with
 *  the replay_id riding inside (as bus-replay.ts stores it). */
export async function insertCaseEvent(
  pool: pg.Pool,
  eventId: string,
  eventType: string,
  occurredAt: string,
  data: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `insert into raw.raw_events (source, event_id, event_type, payload)
     values ('casebus', $1, $2, $3::jsonb)`,
    [eventId, eventType, JSON.stringify({ event_id: eventId, event_type: eventType, occurred_at: occurredAt, data: { ...data, replay_id: `rpl_${eventId}` } })],
  );
}

/** Stripefeed-shaped raw insert: the envelope's data.object IS payload.data (the
 *  connector's door mapping); occurred_at is the envelope's s-epoch created, ISO. */
export async function insertStripeEvent(
  pool: pg.Pool,
  eventId: string,
  eventType: string,
  occurredAt: string,
  object: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `insert into raw.raw_events (source, event_id, event_type, payload)
     values ('stripefeed', $1, $2, $3::jsonb)`,
    [eventId, eventType, JSON.stringify({ event_id: eventId, event_type: eventType, occurred_at: occurredAt, data: object })],
  );
}
