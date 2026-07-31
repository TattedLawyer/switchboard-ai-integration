with events as (
    -- received_at: the successor tiebreak's second clock (see stg_crm__companies.sql).
    select event_id, payload, received_at from raw.raw_events
    where source = 'billing' and event_type = 'customer.created'
),
latest as (
    select distinct on (payload -> 'data' ->> 'id') payload -> 'data' as customer
    from events
    order by payload -> 'data' ->> 'id',
             ((payload ->> 'occurred_at')::timestamptz) desc,
             received_at desc,
             event_id desc
)
select
    customer ->> 'id'     as customer_id,
    customer ->> 'name'   as name,
    customer ->> 'domain' as domain,
    customer ->> 'email'  as email
from latest
