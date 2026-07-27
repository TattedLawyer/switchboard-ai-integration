with events as (
    select event_id, payload from raw.raw_events
    where source = 'crm' and event_type = 'deal.updated'
),
latest as (
    select distinct on (payload -> 'data' ->> 'id') payload -> 'data' as deal
    from events
    order by payload -> 'data' ->> 'id',
             ((payload ->> 'occurred_at')::timestamptz) desc,
             (substring(event_id from 5))::bigint desc
)
select
    deal ->> 'id'         as deal_id,
    deal ->> 'company_id' as company_id,
    deal ->> 'name'       as name,
    -- L2 safe cast: raw rows that never passed the ingest door (legacy, direct inserts,
    -- historical backfill) must degrade to NULL, not kill the whole build. The ingest
    -- contract (ingest/src/numeric-contract.ts) is the enforcement; this is blast-radius
    -- containment. NULLs are surfaced by the mart's unusable-amount counters (L3) and the
    -- not_null dbt tests (L4).
    case when pg_input_is_valid(deal ->> 'amount_cents', 'bigint')
         then (deal ->> 'amount_cents')::bigint end as amount_cents,
    deal ->> 'status'     as status
from latest
