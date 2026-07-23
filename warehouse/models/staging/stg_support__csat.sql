with events as (
    select event_id, payload from raw.raw_events
    where source = 'support' and event_type = 'csat.recorded'
),
latest as (
    select distinct on (payload -> 'data' ->> 'ticket_id') payload -> 'data' as csat
    from events
    order by payload -> 'data' ->> 'ticket_id',
             (payload ->> 'occurred_at') desc,
             (substring(event_id from 5))::bigint desc
)
select
    csat ->> 'id'        as csat_id,
    csat ->> 'ticket_id' as ticket_id,
    (csat ->> 'score')::int as score
from latest
