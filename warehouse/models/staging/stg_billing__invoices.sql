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
             (payload ->> 'occurred_at') desc,
             (substring(event_id from 5))::bigint desc
)
select
    invoice ->> 'id'          as invoice_id,
    invoice ->> 'customer_id' as customer_id,
    (invoice ->> 'amount_cents')::bigint as amount_cents,
    status
from latest
