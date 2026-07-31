-- Derived, deterministic, batch-recomputed over full history every build. This model is a
-- pure function of the append-only raw SET, and raw is NEVER rewritten: no incremental
-- state accumulates, so a build sees the same rows however they got there, and transitive
-- merges A→B→C resolve identically regardless of the order the events were delivered in.
-- One edge per from_id (a re-merged source: latest occurred_at wins, successor tiebreak —
-- received_at desc then event_id desc; the evt-N ordinal is retired, see
-- staging/stg_crm__companies.sql and ingest/test/tiebreak-successor.test.ts).
--
-- D5, NARROWED (Task C, deliberate): the successor tiebreak's second key IS arrival order,
-- so order-independence no longer extends to a TRUE occurred_at TIE. Two company.merged
-- events for the same from_id sharing an occurred_at now crown the later-ARRIVING one, and
-- replaying that same pair in the other delivery order yields the other edge — and a
-- different canonical. That is the priced cost of retiring the evt-N ordinal, which was a
-- 2a-mock emission counter that mis-ordered real vendor ids and threw 22P02 on Stripe-shaped
-- ones: a tiebreak that is wrong on real data is worse than one that is order-sensitive on
-- an exact tie. The divergence is pinned, not assumed —
-- ingest/test/tiebreak-successor.test.ts:250-266 ("divergence 1") proves it for THIS model
-- under both orderings. What still holds: the batch recompute above, and ordering by
-- occurred_at first, so anything with distinct event times is delivery-order independent.
with merge_events as (
    select
        payload -> 'data' ->> 'from_id' as from_id,
        payload -> 'data' ->> 'to_id'   as to_id,
        payload ->> 'occurred_at'       as occurred_at,
        event_id,
        received_at
    from raw.raw_events
    where source = 'crm' and event_type = 'company.merged'
)
-- occurred_at ordered as timestamptz, not text (L2-G2) — see the cast rationale comment in
-- staging/stg_crm__companies.sql. The ingest gate guarantees castability.
select distinct on (from_id) from_id, to_id, occurred_at
from merge_events
order by from_id, (occurred_at)::timestamptz desc, received_at desc, event_id desc
