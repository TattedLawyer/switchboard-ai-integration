with events as (
    select event_id, event_type, payload from raw.raw_events
    where source = 'billing' and event_type in ('payment.succeeded', 'payment.failed')
),
latest as (
    select distinct on (payload -> 'data' ->> 'id')
        payload -> 'data' as payment,
        split_part(event_type, '.', 2) as status
    from events
    order by payload -> 'data' ->> 'id',
             (payload ->> 'occurred_at') desc,
             (substring(event_id from 5))::bigint desc
)
select
    payment ->> 'id'          as payment_id,
    payment ->> 'invoice_id'  as invoice_id,
    payment ->> 'customer_id' as customer_id,
    (payment ->> 'amount_cents')::bigint as amount_cents,
    status
from latest
