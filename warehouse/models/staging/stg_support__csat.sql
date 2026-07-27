with events as (
    select event_id, payload from raw.raw_events
    where source = 'support' and event_type = 'csat.recorded'
),
latest as (
    select distinct on (payload -> 'data' ->> 'ticket_id') payload -> 'data' as csat
    from events
    order by payload -> 'data' ->> 'ticket_id',
             ((payload ->> 'occurred_at')::timestamptz) desc,
             (substring(event_id from 5))::bigint desc
)
select
    csat ->> 'id'        as csat_id,
    csat ->> 'ticket_id' as ticket_id,
    -- L2 safe cast: raw rows that never passed the ingest door (legacy, direct inserts,
    -- historical backfill) must degrade to NULL, not kill the whole build. The ingest
    -- contract (ingest/src/numeric-contract.ts) is the enforcement; this is blast-radius
    -- containment. NULLs are surfaced by the mart's unusable-amount counters (L3) and the
    -- not_null dbt tests (L4).
    case when pg_input_is_valid(csat ->> 'score', 'integer')
         then (csat ->> 'score')::int end as score
from latest
