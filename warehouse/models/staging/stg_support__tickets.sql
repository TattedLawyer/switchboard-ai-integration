-- Re-sourced (F-1c): the support arm stages from the casebus event-bus wire. A faithful
-- Case wire carries the requester's identity as the SUPPLIED-* intake fields on the
-- CREATE event only (f2-wire-research.md Q2: create = full state; updates are
-- changed-only deltas — supplied fields are never re-sent), so:
--   · requester_email/name/company come VERBATIM from the create's SuppliedEmail /
--     SuppliedName / SuppliedCompany;
--   · domain is DERIVED from SuppliedEmail — the Case object has no domain field, and
--     the universe guarantees a domain-evidence requester's email carries its evidence
--     (wire-evidence.test.ts). The derived domain flows through the existing free-email
--     gate at identity_resolution's tier 2, like the sheets arm's derived domains;
--   · priority starts at the create's value and follows changed-only case.updated
--     frames whose field names it;
--   · case.closed decides status; solved_at = created_at + resolution_minutes (the
--     wire's own duration fact); sla_due_at = created_at + the ORG-SIDE SLA policy
--     (high 24h, else 72h) — SLA policy is org configuration, not wire data, and this
--     is the same policy the manifest universe encodes.
-- Latest-per-case uses the successor ordering (occurred_at timestamptz desc,
-- received_at desc, event_id desc — see stg_crm__companies.sql for the cast rationale).
with created as (
    select distinct on (payload -> 'data' ->> 'case_id')
        payload -> 'data' as c,
        (payload ->> 'occurred_at')::timestamptz as created_at
    from raw.raw_events
    where source = 'casebus' and event_type = 'case.created'
    order by payload -> 'data' ->> 'case_id',
             ((payload ->> 'occurred_at')::timestamptz) desc,
             received_at desc,
             event_id desc
),
priority_updates as (
    select distinct on (payload -> 'data' ->> 'case_id')
        payload -> 'data' ->> 'case_id'   as case_id,
        payload -> 'data' ->> 'new_value' as priority
    from raw.raw_events
    where source = 'casebus' and event_type = 'case.updated'
      and payload -> 'data' ->> 'field' = 'priority'
    order by payload -> 'data' ->> 'case_id',
             ((payload ->> 'occurred_at')::timestamptz) desc,
             received_at desc,
             event_id desc
),
closed as (
    select distinct on (payload -> 'data' ->> 'case_id')
        payload -> 'data' ->> 'case_id' as case_id,
        -- L2 safe cast: resolution_minutes is contract-required at the door; a doorless
        -- garbage value degrades to NULL here (solved_at goes NULL, never a dead build).
        case when pg_input_is_valid(payload -> 'data' ->> 'resolution_minutes', 'bigint')
             then (payload -> 'data' ->> 'resolution_minutes')::bigint end as resolution_minutes
    from raw.raw_events
    where source = 'casebus' and event_type = 'case.closed'
    order by payload -> 'data' ->> 'case_id',
             ((payload ->> 'occurred_at')::timestamptz) desc,
             received_at desc,
             event_id desc
),
enriched as (
    select
        cr.c ->> 'case_id'                          as ticket_id,
        cr.c ->> 'requester_id'                     as requester_id,
        cr.c ->> 'SuppliedEmail'                    as requester_email,
        cr.c ->> 'SuppliedName'                     as requester_name,
        cr.c ->> 'SuppliedCompany'                  as company_name,
        nullif(split_part(cr.c ->> 'SuppliedEmail', '@', 2), '') as domain,
        coalesce(pu.priority, cr.c ->> 'priority')  as priority,
        cr.created_at,
        cl.case_id                                  as closed_case_id,
        cl.resolution_minutes
    from created cr
    left join priority_updates pu on pu.case_id = cr.c ->> 'case_id'
    left join closed cl           on cl.case_id = cr.c ->> 'case_id'
)
select
    ticket_id,
    requester_id,
    requester_email,
    requester_name,
    company_name,
    domain,
    priority,
    created_at,
    created_at + case when priority = 'high' then interval '24 hours'
                      else interval '72 hours' end as sla_due_at,
    case when closed_case_id is not null and resolution_minutes is not null
         then created_at + resolution_minutes * interval '1 minute' end as solved_at,
    case when closed_case_id is not null then 'solved' else 'open' end as status
from enriched
