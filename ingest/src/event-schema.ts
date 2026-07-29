// The ONE definition of what may enter raw. Extracted (Step 0 of the numeric-integrity
// work) because raw has multiple doors — the webhook (server.ts), the quarantine replay
// (quarantine.ts), the backfill poll (backfill.ts), and any future connector — and all of
// them must apply the same predicate. The schema used to be duplicated between server.ts
// and quarantine.ts because importing it from server.ts into quarantine.ts would have been
// a runtime cycle (server.ts imports quarantineEvent from quarantine.ts). This module sits
// at the BOTTOM of the src import graph: its only src import is numeric-contract.ts, which
// is itself a strict leaf (imports nothing from src), so a cycle is impossible by construction.
import { z } from "zod";
import { numericContractViolation } from "./numeric-contract.js";

// occurred_at gate (L2-G2): staging latest-state views order by
// (payload ->> 'occurred_at')::timestamptz, and that cast THROWS on garbage — so a non-timestamp
// occurred_at must never reach raw.raw_events. This predicate is the single definition used by
// ALL THREE doors into raw: the webhook schema in server.ts, the backfill poll path (which
// applies that same schema in backfill.ts), and the replay schema in quarantine.ts. The poll
// path was once ungated and this comment once said "BOTH" — the count is the invariant, so if a
// fourth door is ever added it applies here too. It lives in this leaf module (historically in
// quarantine.ts, because server.ts already imported from that module and the reverse import
// would have been a runtime cycle). Accepted shape: full ISO-8601 date+time with seconds and an
// explicit zone (Z or ±HH:MM), and the string must actually parse as a date (rejects e.g. month 13).
const ISO_8601_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
export function isIsoOccurredAt(s: string): boolean {
  return ISO_8601_SHAPE.test(s) && !Number.isNaN(Date.parse(s));
}

// A6: occurred_at is the latest-state SORT KEY, so an absurd-but-well-formed timestamp
// is data corruption, not a formatting nit: "9999-12-31T00:00:00Z" would pin an entity's
// state forever, undislodgeable by any later correct event, triggered by nothing more
// exotic than a vendor timezone bug. Bound it to [now-30d, now+5m] — 30d absorbs
// legitimate replays/backfills of recent history, +5m absorbs ordinary clock skew
// (mirrors the A3 signature window). Out-of-window events QUARANTINE (preserved, never
// dropped); note a quarantined event replayed after its window ages out stays
// still-invalid — staleness is a property of the data, not of when we look at it.
export const OCCURRED_AT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const OCCURRED_AT_MAX_FUTURE_MS = 5 * 60 * 1000;
export function isAcceptableOccurredAt(s: string, nowMs: number = Date.now()): boolean {
  if (!isIsoOccurredAt(s)) return false;
  const t = Date.parse(s);
  return t >= nowMs - OCCURRED_AT_MAX_AGE_MS && t <= nowMs + OCCURRED_AT_MAX_FUTURE_MS;
}

// Raw has THREE doors, not two: the webhook (server.ts), the quarantine replay
// (quarantine.ts), and the backfill poll path in backfill.ts. All three must apply the same
// predicate — the poll path once did not, and could put a value in raw that throws the
// staging cast. The definition lives HERE, with the predicates it depends on.
export const eventSchema = z
  .object({
    event_id: z.string().min(1),
    event_type: z.string().min(1),
    // L2-G2 + A6: staging orders latest-state by (occurred_at)::timestamptz (throws on garbage)
    // and the window bound keeps absurd-but-well-formed timestamps from pinning state —
    // so garbage must be gated out HERE. Schema-invalid delivered payloads follow the existing
    // malformed-data path (quarantine); nothing delivered is ever dropped. The same
    // predicate guards the replay door in quarantine.ts.
    occurred_at: z
      .string()
      .refine((s) => isAcceptableOccurredAt(s), "occurred_at must be ISO-8601 within [now-30d, now+5m]"),
    data: z.record(z.unknown()),
  })
  .superRefine((ev, ctx) => {
    // L1 numeric contract: the rule for `data` depends on its sibling event_type, hence
    // superRefine. Because this lives on the shared schema, every door (webhook, replay,
    // backfill poll, future connectors) enforces it at once — no door can drift.
    const violation = numericContractViolation(ev.event_type, ev.data);
    if (violation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["data", violation.field],
        message: violation.reason,
      });
    }
  });

export type SourceEvent = z.infer<typeof eventSchema>;
