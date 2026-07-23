with events as (
    select event_id, payload from raw.raw_events
    where source = 'crm' and event_type = 'deal.updated'
),
latest as (
    select distinct on (payload -> 'data' ->> 'id') payload -> 'data' as deal
    from events
    order by payload -> 'data' ->> 'id',
             (payload ->> 'occurred_at') desc,
             (substring(event_id from 5))::bigint desc
)
select
    deal ->> 'id'         as deal_id,
    deal ->> 'company_id' as company_id,
    deal ->> 'name'       as name,
    (deal ->> 'amount_cents')::bigint as amount_cents,
    deal ->> 'status'     as status
from latest
