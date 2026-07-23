with events as (
    select event_id, event_type, payload from raw.raw_events
    where source = 'support' and event_type in ('ticket.created', 'ticket.updated', 'ticket.solved')
),
latest as (
    select distinct on (payload -> 'data' ->> 'id')
        payload -> 'data' as ticket,
        case when event_type = 'ticket.solved' then 'solved' else 'open' end as status
    from events
    order by payload -> 'data' ->> 'id',
             (payload ->> 'occurred_at') desc,
             (substring(event_id from 5))::bigint desc
)
select
    ticket ->> 'id'              as ticket_id,
    ticket ->> 'requester_id'    as requester_id,
    ticket ->> 'requester_email' as requester_email,
    ticket ->> 'requester_name'  as requester_name,
    ticket ->> 'company_name'    as company_name,
    ticket ->> 'domain'          as domain,
    ticket ->> 'priority'        as priority,
    (ticket ->> 'created_at')::timestamptz as created_at,
    (ticket ->> 'sla_due_at')::timestamptz as sla_due_at,
    case when status = 'solved' then (ticket ->> 'solved_at')::timestamptz end as solved_at,
    status
from latest
