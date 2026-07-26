-- Derived, deterministic, batch-recomputed over full history every build (D5: arrival order
-- washes out — this model is a pure function of the append-only raw set, so transitive merges
-- A→B→C resolve identically regardless of delivery order). Raw is NEVER rewritten.
-- One edge per from_id (a re-merged source: latest occurred_at wins, evt-ordinal tiebreak).
with merge_events as (
    select
        payload -> 'data' ->> 'from_id' as from_id,
        payload -> 'data' ->> 'to_id'   as to_id,
        payload ->> 'occurred_at'       as occurred_at,
        event_id
    from raw.raw_events
    where source = 'crm' and event_type = 'company.merged'
)
-- occurred_at ordered as timestamptz, not text (L2-G2) — see the cast rationale comment in
-- staging/stg_crm__companies.sql. The ingest gate guarantees castability.
select distinct on (from_id) from_id, to_id, occurred_at
from merge_events
order by from_id, (occurred_at)::timestamptz desc, (substring(event_id from 5))::bigint desc
