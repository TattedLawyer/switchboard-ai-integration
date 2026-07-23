with events as (
    select event_id, payload from raw.raw_events
    where source = 'crm' and event_type = 'contact.updated'
),
latest as (
    select distinct on (payload -> 'data' ->> 'id') payload -> 'data' as contact
    from events
    order by payload -> 'data' ->> 'id',
             (payload ->> 'occurred_at') desc,
             (substring(event_id from 5))::bigint desc
)
select
    contact ->> 'id'         as contact_id,
    contact ->> 'company_id' as company_id,
    contact ->> 'name'       as name,
    contact ->> 'email'      as email
from latest
