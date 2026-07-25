with company_events as (
    select event_id, payload, received_at
    from raw.raw_events
    -- company.updated only: company.merged carries {from_id, to_id} (no id/name), which
    -- would otherwise collapse into a NULL company_id row. Merge handling is Task 9's job.
    where source = 'crm' and event_type = 'company.updated'
),
latest as (
    -- Latest state per company is decided by EVENT time (occurred_at), not arrival time
    -- (received_at): out-of-order delivery must never let a stale update win. The evt-N
    -- ordinal is the deterministic tiebreak for identical occurred_at values.
    -- occurred_at is compared as timestamptz, NOT text (L2-G2): text ordering mis-picks across
    -- timezone offsets and mixed precision (e.g. "…T10:00:00+05:00" is EARLIER in real time
    -- than "…T09:00:00Z" but sorts later as a string). The cast throws on garbage — acceptable
    -- ONLY because the ingest gate (eventSchema in ingest/src/server.ts, and the replay gate in
    -- ingest/src/quarantine.ts) rejects non-ISO-8601 occurred_at before anything reaches raw.
    -- Same cast applies in all staging views and merge_edges.sql.
    select distinct on (payload -> 'data' ->> 'id')
        payload -> 'data' as company,
        received_at
    from company_events
    order by payload -> 'data' ->> 'id',
             ((payload ->> 'occurred_at')::timestamptz) desc,
             (substring(event_id from 5))::bigint desc
)
select
    company ->> 'id'     as company_id,
    company ->> 'name'   as name,
    company ->> 'domain' as domain,
    received_at          as last_event_at
from latest
