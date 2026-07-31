with events as (
    -- received_at: the successor tiebreak's second clock (see stg_crm__companies.sql).
    select event_id, event_type, payload, received_at from raw.raw_events
    where source = 'billing' and event_type in ('payment.succeeded', 'payment.failed')
),
latest as (
    select distinct on (payload -> 'data' ->> 'id')
        payload -> 'data' as payment,
        split_part(event_type, '.', 2) as status
    from events
    order by payload -> 'data' ->> 'id',
             ((payload ->> 'occurred_at')::timestamptz) desc,
             received_at desc,
             event_id desc
)
select
    payment ->> 'id'          as payment_id,
    payment ->> 'invoice_id'  as invoice_id,
    payment ->> 'customer_id' as customer_id,
    -- L2 safe cast: raw rows that never passed the ingest door (legacy, direct inserts,
    -- historical backfill) must degrade to NULL, not kill the whole build. The ingest
    -- contract (ingest/src/numeric-contract.ts) is the enforcement; this is blast-radius
    -- containment. NULLs are deliberately left visible for downstream
    -- surfacing (numeric-integrity plan, L3/L4 tasks) rather than erased or guessed at.
    case when pg_input_is_valid(payment ->> 'amount_cents', 'bigint')
         then (payment ->> 'amount_cents')::bigint end as amount_cents,
    status
from latest
