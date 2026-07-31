with events as (
    -- received_at: the successor tiebreak's second clock (see stg_crm__companies.sql).
    select event_id, payload, received_at from raw.raw_events
    where source = 'crm' and event_type = 'contact.updated'
),
latest as (
    select distinct on (payload -> 'data' ->> 'id') payload -> 'data' as contact
    from events
    order by payload -> 'data' ->> 'id',
             ((payload ->> 'occurred_at')::timestamptz) desc,
             received_at desc,
             event_id desc
)
select
    contact ->> 'id'         as contact_id,
    contact ->> 'company_id' as company_id,
    contact ->> 'name'       as name,
    contact ->> 'email'      as email
from latest
