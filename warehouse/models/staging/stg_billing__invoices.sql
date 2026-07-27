with events as (
    select event_id, event_type, payload from raw.raw_events
    where source = 'billing' and event_type in ('invoice.created', 'invoice.paid', 'invoice.voided')
),
latest as (
    select distinct on (payload -> 'data' ->> 'id')
        payload -> 'data' as invoice,
        split_part(event_type, '.', 2) as status
    from events
    order by payload -> 'data' ->> 'id',
             ((payload ->> 'occurred_at')::timestamptz) desc,
             (substring(event_id from 5))::bigint desc
)
select
    invoice ->> 'id'          as invoice_id,
    invoice ->> 'customer_id' as customer_id,
    -- L2 safe cast: raw rows that never passed the ingest door (legacy, direct inserts,
    -- historical backfill) must degrade to NULL, not kill the whole build. The ingest
    -- contract (ingest/src/numeric-contract.ts) is the enforcement; this is blast-radius
    -- containment. NULLs are surfaced by the mart's unusable-amount counters (L3) and the
    -- not_null dbt tests (L4).
    case when pg_input_is_valid(invoice ->> 'amount_cents', 'bigint')
         then (invoice ->> 'amount_cents')::bigint end as amount_cents,
    status
from latest
