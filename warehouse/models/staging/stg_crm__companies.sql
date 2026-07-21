with company_events as (
    select payload, received_at
    from raw.raw_crm_events
    where event_type like 'company.%'
),
latest as (
    select distinct on (payload -> 'data' ->> 'id')
        payload -> 'data' as company,
        received_at
    from company_events
    order by payload -> 'data' ->> 'id', received_at desc
)
select
    company ->> 'id'     as company_id,
    company ->> 'name'   as name,
    company ->> 'domain' as domain,
    received_at          as last_event_at
from latest
