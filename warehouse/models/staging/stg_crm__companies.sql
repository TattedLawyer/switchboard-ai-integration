with company_events as (
    select event_id, payload, received_at
    from raw.raw_crm_events
    where event_type like 'company.%'
),
latest as (
    -- Latest state per company is decided by EVENT time (occurred_at), not arrival time
    -- (received_at): out-of-order delivery must never let a stale update win. The evt-N
    -- ordinal is the deterministic tiebreak for identical occurred_at values.
    select distinct on (payload -> 'data' ->> 'id')
        payload -> 'data' as company,
        received_at
    from company_events
    order by payload -> 'data' ->> 'id',
             (payload ->> 'occurred_at') desc,
             (substring(event_id from 5))::bigint desc
)
select
    company ->> 'id'     as company_id,
    company ->> 'name'   as name,
    company ->> 'domain' as domain,
    received_at          as last_event_at
from latest
