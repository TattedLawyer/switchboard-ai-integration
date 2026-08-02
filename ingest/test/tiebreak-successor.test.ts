import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { loadModel } from "./helpers/load-model.js";

// ── The evt-N tiebreak retirement (Task C pair 1; register LANDMINE L2-G6 / LANDMINE-2b/3) ──
//
// Every 2a staging model and merge_edges broke latest-state ties with
// `(substring(event_id from 5))::bigint desc` — the mock's own emission ordinal. No real
// vendor id carries that ordinal: a HubSpot eventId ("3816279531") parses to garbage and a
// Stripe id ("evt_1a2b…") THROWS 22P02, killing the whole staging layer on its first
// vendor-faithful event. The successor (phase plan §3.1, binding; sheets was born with it):
//
//     occurred_at desc, received_at desc, event_id desc
//
// This suite is the swap's evidence, in three parts:
//   1. IDENTICAL-WINNERS PIN — on 2a-shaped (evt-N) data, the successor produces the same
//      latest-state winner as the retired ordinal, row-for-row, for every model. The seeded
//      fixtures cover the delivery shapes the 2a mocks actually produce (distinct
//      occurred_at; same-occurred_at ties with arrival aligned to the ordinal; full
//      occurred_at+received_at ties within one ordinal digit width).
//   2. TIE ENUMERATION + DOCUMENTED DIVERGENCE — the two synthetic shapes where the
//      successor picks a DIFFERENT winner than the ordinal are pinned explicitly under
//      BOTH orderings, as a loud spec change (see the divergence describe below), never
//      hidden inside a green equivalence test.
//   3. VENDOR-ID SAFETY — real-vendor-shaped ids flow through every model without a throw
//      (RED against the ordinal: the cast dies with 22P02).
//
// Both orderings run against the REAL model text: the successor is loaded from disk
// (loadModel — no mirrors, house rule B2), and the retired ordinal variant is DERIVED from
// that same text by swapping exactly the tiebreak clause. The ordinal is retired spec — a
// frozen historical reference is the one kind of "copy" that cannot drift, because the
// thing it describes no longer changes.
//
// NARROWED (F-1c, deliberate): the staging switch re-sourced eight of the nine models
// away from 2a-shaped feeds (hubcrm snapshots / stripefeed envelopes / the casebus bus),
// so the "identical winner on 2a-shaped delivery" question is MOOT for them — they can
// no longer receive 2a-shaped data at all, and their fixtures here stopped compiling
// against reality. What survives of this suite's claims, and where each lives now:
//   · the ordinal cast is GONE from every model's text — still asserted here, all nine;
//   · the equivalence + divergence + vendor-id-safety machinery runs on the one model
//     still consuming a 2a feed: stg_support__csat (the 2a support mock remains for the
//     csat arm — the decided end-state);
//   · the re-sourced models' successor ordering and vendor-shaped-id behavior are
//     pinned on their OWN source shapes in staging-flip.test.ts (hub event ids are
//     numeric, stripefeed ids are evt_<opaque>, casebus ids are cev_<opaque> — every
//     fixture there is vendor-shaped, so "no throw on vendor ids" is exercised by
//     construction on every pin).

let pool: pg.Pool;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ pool, cleanup } = await freshTestDb());
});
afterEach(async () => {
  await cleanup();
});

const ORDINAL_TIEBREAK = "(substring(event_id from 5))::bigint desc";
const SUCCESSOR_TAIL = /received_at desc,\s*\n?\s*event_id desc/g;

/** Derive the RETIRED ordinal ordering from the on-disk successor text. Throws loudly
 *  when the model does not carry the successor clause exactly once — which is also this
 *  suite's RED condition before the swap lands. */
function ordinalVariant(sql: string): string {
  const matches = sql.match(SUCCESSOR_TAIL);
  if (!matches || matches.length !== 1) {
    throw new Error(
      `model does not carry the successor tiebreak exactly once (found ${matches?.length ?? 0}) — ` +
        "either the evt-N ordinal is still in place (RED) or the ordering clause moved",
    );
  }
  return sql.replace(SUCCESSOR_TAIL, ORDINAL_TIEBREAK);
}

interface ModelSpec {
  title: string;
  path: string;
  source: string;
  eventType: string;
  /** Output column carrying the entity id. */
  idColumn: string;
  /** Output column that identifies WHICH event won latest-state. */
  markerColumn: string;
  makeData(entityId: string, marker: string): Record<string, unknown>;
}

// All nine models that carried the ordinal (8 staging + merge_edges); stg_sheets__rows
// is absent on purpose — born with the successor (A6), never had the cast.
// Eight of the nine are re-sourced (F-1c) — only their
// no-ordinal TEXT assertion remains here (see the header's narrowing note); their
// ordering behavior is pinned in staging-flip.test.ts on their own source shapes.
const RESOURCED_MODEL_PATHS: { title: string; path: string }[] = [
  { title: "stg_crm__companies", path: "models/staging/stg_crm__companies.sql" },
  { title: "stg_crm__contacts", path: "models/staging/stg_crm__contacts.sql" },
  { title: "stg_crm__deals", path: "models/staging/stg_crm__deals.sql" },
  { title: "stg_billing__customers", path: "models/staging/stg_billing__customers.sql" },
  { title: "stg_billing__invoices", path: "models/staging/stg_billing__invoices.sql" },
  { title: "stg_billing__payments", path: "models/staging/stg_billing__payments.sql" },
  { title: "stg_support__tickets", path: "models/staging/stg_support__tickets.sql" },
  { title: "merge_edges", path: "models/identity/merge_edges.sql" },
];

// The one model still consuming a 2a-shaped feed (the support mock remains for csat):
// the full equivalence/divergence/vendor-safety machinery keeps running here.
const MODELS: ModelSpec[] = [
  {
    title: "stg_support__csat", path: "models/staging/stg_support__csat.sql",
    source: "support", eventType: "csat.recorded", idColumn: "ticket_id", markerColumn: "csat_id",
    makeData: (id, marker) => ({ id: marker, ticket_id: id, score: 3 }),
  },
];

async function insertEvent(
  spec: ModelSpec,
  eventId: string,
  entityId: string,
  marker: string,
  occurredAt: string,
  receivedAt: string,
): Promise<void> {
  await pool.query(
    `insert into raw.raw_events (source, event_id, event_type, payload, received_at)
     values ($1, $2, $3, $4::jsonb, $5)`,
    [
      spec.source,
      eventId,
      spec.eventType,
      JSON.stringify({ occurred_at: occurredAt, data: spec.makeData(entityId, marker) }),
      receivedAt,
    ],
  );
}

async function winners(sql: string, spec: ModelSpec): Promise<Map<string, string>> {
  const res = await pool.query(`select * from (${sql}) m order by ${spec.idColumn}`);
  return new Map(res.rows.map((r) => [String(r[spec.idColumn]), String(r[spec.markerColumn])]));
}

// occurred_at values inside the door's [now-30d, now+5m] window so the same fixture would
// pass ingest; received_at values are explicit so arrival order is a controlled input.
const T = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

describe.each(RESOURCED_MODEL_PATHS)("$title — evt-N ordinal stays retired (re-sourced model)", ({ path }) => {
  it("the evt-N ordinal cast is gone from the model text", () => {
    // Text-only load; the billing models ref numeric_bounds since Wave 5 (inert here).
    expect(loadModel(path, { numeric_bounds: "numeric_bounds" })).not.toContain("substring(event_id from 5)");
  });
});

describe.each(MODELS)("$title — evt-N tiebreak retirement", (spec) => {
  it("the evt-N ordinal cast is gone from the model text", () => {
    expect(loadModel(spec.path)).not.toContain("substring(event_id from 5)");
  });

  it("2a-identical-latest-state pin: the successor and the retired ordinal pick the SAME winner, row-for-row, on 2a-shaped delivery", async () => {
    // Entity A — distinct occurred_at, delivery order == emission order (the 2a common
    // case). Tiebreak never consulted; occurred_at alone decides under both orderings.
    await insertEvent(spec, "evt-1", "A", "A-old", T(50), T(40));
    await insertEvent(spec, "evt-2", "A", "A-mid", T(30), T(29));
    await insertEvent(spec, "evt-3", "A", "A-new", T(10), T(9));

    // Entity B — distinct occurred_at, SHUFFLED delivery (late-delivered stale event, the
    // out-of-order fault): received_at order inverted vs occurred_at. Both orderings must
    // still crown the newest occurred_at.
    await insertEvent(spec, "evt-4", "B", "B-new", T(5), T(20));
    await insertEvent(spec, "evt-5", "B", "B-stale", T(60), T(4));

    // Entity C — the known 2a tie shape: same-millisecond occurred_at (the mocks mint
    // occurred_at with new Date().toISOString() in a tight loop — drop/shuffle iterations
    // skip the awaited delivery, so consecutive events CAN share a millisecond), with
    // arrival aligned to emission (no shuffle). The ordinal picked the higher emission
    // ordinal; the successor's received_at desc resolves to the SAME winner because
    // aligned delivery makes arrival order equal emission order.
    const tieC = T(15);
    await insertEvent(spec, "evt-6", "C", "C-first", tieC, T(14));
    await insertEvent(spec, "evt-7", "C", "C-second", tieC, T(13));

    // Entity D — full tie: same occurred_at AND same received_at, ordinals within one
    // digit width. event_id desc (lexicographic) equals ordinal order there, so the
    // winner is again identical. (The digit-width-crossing full tie is the documented
    // divergence — pinned separately below, not smuggled into this green pin.)
    const tieD = T(12);
    const recvD = T(11);
    await insertEvent(spec, "evt-8", "D", "D-first", tieD, recvD);
    await insertEvent(spec, "evt-9", "D", "D-second", tieD, recvD);

    const successorSql = loadModel(spec.path);
    const ordinalSql = ordinalVariant(successorSql);

    const successorWinners = await winners(successorSql, spec);
    const ordinalWinners = await winners(ordinalSql, spec);

    // Row-for-row identity: same entities, same winning event for each.
    expect(Object.fromEntries(successorWinners)).toEqual(Object.fromEntries(ordinalWinners));

    // And the enumerated tie cases resolve to the winner the ordinal chose:
    expect(successorWinners.get("A")).toBe("A-new");
    expect(successorWinners.get("B")).toBe("B-new");
    expect(successorWinners.get("C")).toBe("C-second"); // received_at broke the tie, same as ordinal
    expect(successorWinners.get("D")).toBe("D-second"); // event_id desc broke the full tie, same as ordinal
  });

  it("vendor-id safety: real-vendor-shaped event ids (HubSpot numeric, Stripe evt_<opaque>) flow through without a throw", async () => {
    // Under the ordinal, "3816279531" substrings to "279531" (silent garbage ordering)
    // and "evt_1a2b3c" substrings to "a2b3c" → 22P02, killing the whole model. The
    // successor must simply order them.
    await insertEvent(spec, "3816279531", "V", "V-old", T(40), T(39));
    await insertEvent(spec, "evt_1a2b3c9x8y7z6w5v4u3t2s", "V", "V-new", T(10), T(9));

    const res = await winners(loadModel(spec.path), spec);
    expect(res.get("V")).toBe("V-new");
  });
});

// ── The documented divergence: where the successor is a SPEC CHANGE, not a re-proof ─────
//
// Two synthetic tie shapes exist where the retired ordinal and the successor disagree.
// Both are pinned here under BOTH orderings so the change is loud, enumerated, and
// deliberate (phase plan §3.1 made the successor binding; the brief forbids hiding any
// divergence inside the equivalence pin).
//
// Why the change is right: the ordinal was the 2a mocks' private emission counter — it
// does not exist on any real vendor id, so "emission order" is simply not evidence the
// production system will ever have again. When the source's own clock (occurred_at) cannot
// distinguish two states, the honest remaining evidence is our ingest clock (received_at),
// then a deterministic last-resort (event_id desc) — exactly the ordering stg_sheets__rows
// was born with (A6) and the same "later ingest wins a detection-clock tie" semantics its
// model comment documents.
//
// Producibility on 2a data (verified against mocks/core/src/source-app.ts):
//   * Divergence 1 (arrival-inverted same-ms tie) IS producible in principle: the shuffle
//     fault holds an event back (its occurred_at already minted, no awaited delivery in
//     that loop iteration) and delivers it AFTER later-minted events — same-millisecond
//     occurred_at across the pair is possible because the deferring iteration skips the
//     HTTP round-trip. It additionally requires both events to target the SAME entity, so
//     it is rare — but it is real, and after the swap the later-ARRIVING event wins where
//     the higher ordinal used to. The demo pipeline (scripts/demo.sh) runs without
//     shuffle faults; the chaos oracle asserts set-equality (zero loss), not winner
//     content — neither gates on this tie's winner.
//   * Divergence 2 (digit-width-crossing full tie) requires identical received_at, which
//     needs two separate ingest transactions to commit in the same MICROSECOND — not
//     producible by the sequential awaited 2a delivery path; synthetic only.
describe("documented spec change: ties the successor resolves DIFFERENTLY than the retired ordinal", () => {
  const spec = MODELS[0]; // representative: stg_support__csat — the one still-2a-sourced model (F-1c narrowing)

  it("divergence 1 — same occurred_at, arrival inverted by the shuffle fault: successor crowns the later ARRIVAL, ordinal crowned the later EMISSION", async () => {
    const tie = T(20);
    // evt-9 emitted later but DELIVERED first; evt-3 emitted earlier, held back by the
    // shuffle fault, delivered last.
    await insertEvent(spec, "evt-9", "S", "later-emission", tie, T(19));
    await insertEvent(spec, "evt-3", "S", "later-arrival", tie, T(2));

    const successorSql = loadModel(spec.path);
    const ordinalSql = ordinalVariant(successorSql);

    expect((await winners(ordinalSql, spec)).get("S")).toBe("later-emission"); // the retired behavior
    expect((await winners(successorSql, spec)).get("S")).toBe("later-arrival"); // the successor behavior
  });

  it("divergence 2 — full tie (same occurred_at AND received_at) across a digit-width boundary: successor's lexicographic event_id desc picks evt-9 over evt-10", async () => {
    const tie = T(20);
    const recv = T(15);
    await insertEvent(spec, "evt-9", "W", "ordinal-9", tie, recv);
    await insertEvent(spec, "evt-10", "W", "ordinal-10", tie, recv);

    const successorSql = loadModel(spec.path);
    const ordinalSql = ordinalVariant(successorSql);

    expect((await winners(ordinalSql, spec)).get("W")).toBe("ordinal-10"); // 10 > 9 numerically
    expect((await winners(successorSql, spec)).get("W")).toBe("ordinal-9"); // "evt-9" > "evt-10" lexicographically
  });
});
