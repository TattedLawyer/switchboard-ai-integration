// The event-bus stream's state: a subscribe/replay event bus over the SAME manifest
// universe as the 2a support mock (identities correlate), with a seeded mock clock and
// the researched 72-hour retention window.
//
// Research contract (phase plan §2, Salesforce Pub/Sub API docs, re-verified 2026-07-31):
//   · "Salesforce stores platform events and change data capture events for 72 hours."
//   · "Replay ID values aren't guaranteed to be contiguous for consecutive events."
//   · "On rare occasions, the stream of retained events can be reset if the Salesforce
//      org is moved to a new instance."
//   · ReplayPreset enum: LATEST | EARLIEST | CUSTOM (Subscribe RPC reference).
//
// The two fields that must never be confused, and are therefore two fields here:
//   · `replay_id` is the CURSOR — opaque, per-event, ordered, deliberately NON-contiguous.
//     Task C paid to retire the `evt-N` ordinal; nothing here may reintroduce arithmetic.
//   · `event.id` is the IDENTITY — the event's own uuid-shaped id, which is what ingest
//     deduplicates on. At-least-once delivery means the SAME identity arrives more than
//     once, sometimes under the same replay id; identity is what makes that absorbable.
//
// The stream's retained set is this paradigm's reconcile truth: there is no ledger file
// and no push channel — the subscription IS the interface.

import { randomUUID } from "node:crypto";
import { generateManifest, prng, type Profile } from "@switchboard/mock-core";

/** Exactly the vendor's enum, spelling and case re-verified at implementation time. */
export const REPLAY_PRESETS = ["LATEST", "EARLIEST", "CUSTOM"] as const;
export type ReplayPreset = (typeof REPLAY_PRESETS)[number];

export interface BusEvent {
  /** Opaque cursor. Ordered, never contiguous, never arithmetic. */
  replay_id: string;
  event: {
    id: string;
    type: string;
    /** ISO-8601. The bus's own event clock (per-source occurred_at normalization). */
    event_time: string;
    payload: Record<string, unknown>;
  };
}

export interface StreamOptions {
  seed: number;
  /** Vertical profile (F-1): threads to generateManifest like the 2a mocks' opts.profile. */
  profile?: Profile;
  /** Research: 72 hours. Overridable only so tests can pin the boundary cheaply; the
   *  default IS the researched contract. */
  retentionHours?: number;
  /** Poison fault (house knob, hubcrm's poisonObjectIds precedent): these EMISSION
   *  ordinals ship an unparseable `event_time`. A vendor clock bug is the realistic way
   *  a single bad event lands mid-batch, and it exercises the standing poison-isolation
   *  rule against a field EVERY event has — so the test does not depend on which slot of
   *  the script cycle happened to carry a contract-bound field. The stream's own
   *  bookkeeping is unaffected: retention and append-order run off an internal clock
   *  value, never off the wire string. */
  poisonEmissionIndexes?: number[];
}

export interface FetchResult {
  events: BusEvent[];
  hasMore: boolean;
  /** The tip of the retained window (null when nothing is retained) — what a LATEST
   *  subscriber persists so its next resubscribe is a CUSTOM from a real position. */
  latestReplayId: string | null;
}

export interface StreamState {
  emit(count: number, opts?: { ageS?: number }): BusEvent[];
  advance(seconds: number): void;
  nowS(): number;
  /** The full retained set, in stream order — the reconcile truth. */
  retained(): BusEvent[];
  /** Emission count over the PROCESS lifetime (the /status seq) — unaffected by resets,
   *  because a reset destroys retained history, not the fact that we emitted. */
  seq(): number;
  /** Current stream identity. Changes on reset, and ONLY on reset. */
  streamId(): string;
  /** The documented second cause: "the stream of retained events can be reset if the
   *  Salesforce org is moved to a new instance." Every outstanding replay id becomes
   *  invalid regardless of age; the replay-id position counter deliberately does NOT
   *  rewind, so a pre-reset cursor can never be silently revalidated by a later event. */
  reset(): string;
  fetch(preset: ReplayPreset, replayId: string | null, numRequested: number): FetchResult;
}

/** A replay id the retained window does not contain — aged out, reset away, or never
 *  minted. The HTTP layer maps this to the documented `…replayid.corrupted` rejection,
 *  which is IDENTICAL for all three: the vendor serves one code, and the cause is not on
 *  the wire. */
export class CorruptedReplayIdError extends Error {
  constructor(readonly replayId: string) {
    super(`Ensure that the replay_id field value in FetchRequest is valid and refers to an event that is within the retention window`);
  }
}

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const pad = (n: number) => String(n).padStart(4, "0");

export function createStream(opts: StreamOptions): StreamState {
  const retentionS = (opts.retentionHours ?? 72) * 3600;
  const { tickets, requesters } = generateManifest(opts.seed, opts.profile).support;

  // Three independent seeded streams so no draw perturbs another.
  const idRand = prng(opts.seed ^ 0x5bf03635);
  const strideRand = prng(opts.seed ^ 0x27d4eb2f);

  const mintedIds = new Set<string>();
  const mintEventId = (): string => {
    for (;;) {
      let id = "cev_";
      for (let i = 0; i < 24; i++) id += ID_ALPHABET[Math.floor(idRand() * ID_ALPHABET.length)];
      if (!mintedIds.has(id)) {
        mintedIds.add(id);
        return id;
      }
    }
  };

  // Replay-id minting: a monotone POSITION advanced by a seeded stride of 2..97 — never
  // 1. That makes "aren't guaranteed to be contiguous" a property the mock ENFORCES
  // rather than merely allows, so a connector that computes cursor+1 misses events in
  // tests instead of in production. The position is base36-rendered behind an `rpl_`
  // prefix: opaque on the wire, ordered underneath, and monotone ACROSS resets.
  let position = 1000;
  const mintReplayId = (): string => {
    position += 2 + Math.floor(strideRand() * 96);
    return `rpl_${position.toString(36)}`;
  };

  const bootS = Math.floor(Date.now() / 1000);
  let offsetS = 0;
  const nowS = () => bootS + offsetS;

  let streamId = randomUUID();
  // The internal clock value rides ALONGSIDE the event, never inside it: a poisoned
  // event_time must corrupt the wire without corrupting the stream's own retention and
  // append-order arithmetic (otherwise the fault would break the mock, not the client).
  interface Entry {
    ev: BusEvent;
    tS: number;
  }
  let entries: Entry[] = [];
  let emitted = 0;
  const poisoned = new Set(opts.poisonEmissionIndexes ?? []);

  // 4-slot script cycle over the shared support universe: created → comment → updated →
  // closed, the Service-Cloud-case lifecycle (spec D8) rather than reinvented entities.
  const script = (i: number): { type: string; payload: Record<string, unknown> } => {
    const n = Math.floor(i / 4);
    const ticket = tickets[n % tickets.length];
    const requester = requesters.find((r) => r.id === ticket.requester_id) ?? requesters[0];
    const base = { case_id: ticket.id, requester_id: requester.id };
    switch (i % 4) {
      case 0:
        return {
          type: "case.created",
          payload: { ...base, subject: ticket.subject, priority: ticket.priority, origin: "email" },
        };
      case 1:
        return {
          type: "case.comment.added",
          payload: { ...base, comment_id: `DEMO-CC-${pad(n + 1)}`, author: "agent", public: true },
        };
      case 2:
        return {
          type: "case.updated",
          payload: { ...base, field: "priority", old_value: "normal", new_value: ticket.priority },
        };
      default: {
        const minutes = Math.max(
          0,
          Math.round((Date.parse(ticket.solved_at) - Date.parse(ticket.created_at)) / 60_000),
        );
        return {
          type: "case.closed",
          payload: { ...base, resolution: "solved", resolution_minutes: minutes },
        };
      }
    }
  };

  const emit = (count: number, emitOpts?: { ageS?: number }): BusEvent[] => {
    const t = nowS() - (emitOpts?.ageS ?? 0);
    const last = entries.at(-1);
    if (last !== undefined && t < last.tS) {
      throw new Error(
        "stream refuses emission: event_time would regress — the bus appends; history never " +
          "interleaves. Emit aged batches first.",
      );
    }
    const batch: BusEvent[] = [];
    for (let i = 0; i < count; i++) {
      const ordinal = emitted++;
      const { type, payload } = script(ordinal);
      const ev: BusEvent = {
        replay_id: mintReplayId(),
        event: {
          id: mintEventId(),
          type,
          event_time: poisoned.has(ordinal) ? "not-a-timestamp" : new Date(t * 1000).toISOString(),
          payload,
        },
      };
      batch.push(ev);
      entries.push({ ev, tS: t });
    }
    return batch;
  };

  const retained = (): BusEvent[] => entries.filter((e) => nowS() - e.tS <= retentionS).map((e) => e.ev);

  const fetch = (preset: ReplayPreset, replayId: string | null, numRequested: number): FetchResult => {
    const window = retained();
    const latestReplayId = window.at(-1)?.replay_id ?? null;
    let start: number;
    if (preset === "EARLIEST") {
      start = 0;
    } else if (preset === "LATEST") {
      // Subscribe from the TIP: nothing already retained is served. A LATEST recovery
      // deliberately abandons the retained window — which is exactly why it is not the
      // connector's default fallback.
      start = window.length;
    } else {
      const idx = window.findIndex((e) => e.replay_id === replayId);
      if (idx === -1) throw new CorruptedReplayIdError(String(replayId));
      start = idx + 1;
    }
    const slice = window.slice(start, start + numRequested);
    return { events: slice, hasMore: start + numRequested < window.length, latestReplayId };
  };

  return {
    emit,
    advance: (seconds: number) => {
      offsetS += seconds;
    },
    nowS,
    retained,
    seq: () => emitted,
    streamId: () => streamId,
    reset: () => {
      entries = [];
      streamId = randomUUID();
      return streamId;
    },
    fetch,
  };
}
