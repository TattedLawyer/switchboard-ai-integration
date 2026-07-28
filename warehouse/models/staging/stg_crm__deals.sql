with events as (
    select event_id, payload from raw.raw_events
    where source = 'crm' and event_type = 'deal.updated'
),
latest as (
    select distinct on (payload -> 'data' ->> 'id') payload -> 'data' as deal
    from events
    order by payload -> 'data' ->> 'id',
             ((payload ->> 'occurred_at')::timestamptz) desc,
             (substring(event_id from 5))::bigint desc
)
select
    deal ->> 'id'         as deal_id,
    deal ->> 'company_id' as company_id,
    deal ->> 'name'       as name,
    -- L2 safe cast: raw rows that never passed the ingest door (legacy, direct inserts,
    -- historical backfill) must degrade to NULL, not kill the whole build. The ingest
    -- contract (ingest/src/numeric-contract.ts) is the enforcement; this is blast-radius
    -- containment. NULLs are deliberately left visible for downstream
    -- surfacing (numeric-integrity plan, L3/L4 tasks) rather than erased or guessed at.
    case when pg_input_is_valid(deal ->> 'amount_cents', 'bigint')
         then (deal ->> 'amount_cents')::bigint end as amount_cents,
    -- L5: currency is carried, not discarded — the mart refuses to sum across currencies.
    -- Currency is payload-controlled text that flows to the mart, the MCP read tool, and
    -- the report's LLM prompt. Constrain it to a three-letter uppercase code at the source:
    -- anything else becomes NULL ("unknown", the L5.1 leniency path) rather than riding a
    -- free-text channel downstream. ISO-4217 allowlisting is registered follow-up work.
    case when (deal ->> 'currency') ~ '^[A-Z]{3}$'
         then deal ->> 'currency' end as currency,
    deal ->> 'status'     as status
from latest
