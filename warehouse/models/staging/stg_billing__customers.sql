with events as (
    select event_id, payload from raw.raw_events
    where source = 'billing' and event_type = 'customer.created'
),
latest as (
    select distinct on (payload -> 'data' ->> 'id') payload -> 'data' as customer
    from events
    order by payload -> 'data' ->> 'id',
             (payload ->> 'occurred_at') desc,
             (substring(event_id from 5))::bigint desc
)
select
    customer ->> 'id'     as customer_id,
    customer ->> 'name'   as name,
    customer ->> 'domain' as domain,
    customer ->> 'email'  as email
from latest
