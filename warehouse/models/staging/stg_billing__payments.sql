-- Re-sourced (F-1c): payments stage from the stripefeed charge family — the charge
-- object (data.object verbatim under payload.data) with the charge id as payment
-- identity and the event type's tail as status: charge.succeeded → succeeded,
-- charge.failed → failed (the same literals the mart already reads). Successor
-- ordering as everywhere (see stg_crm__companies.sql for the cast rationale).
with events as (
    select event_id, event_type, payload, received_at from raw.raw_events
    where source = 'stripefeed' and event_type in ('charge.succeeded', 'charge.failed')
),
latest as (
    select distinct on (payload -> 'data' ->> 'id')
        payload -> 'data' as charge,
        split_part(event_type, '.', 2) as status
    from events
    order by payload -> 'data' ->> 'id',
             ((payload ->> 'occurred_at')::timestamptz) desc,
             received_at desc,
             event_id desc
)
select
    charge ->> 'id'          as payment_id,
    charge ->> 'invoice_id'  as invoice_id,
    charge ->> 'customer_id' as customer_id,
    -- L2 safe cast (see stg_billing__invoices.sql).
    case when pg_input_is_valid(charge ->> 'amount_cents', 'bigint')
         then (charge ->> 'amount_cents')::bigint end as amount_cents,
    status
from latest
