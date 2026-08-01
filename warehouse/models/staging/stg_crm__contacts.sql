-- Re-sourced (F-1c) from hubcrm hydrated snapshots — see stg_crm__companies.sql for the
-- paradigm, the successor-ordering rationale, and the business-key identity decision
-- (contact_id = hs_manifest_id; company linkage rides company_manifest_id, the same
-- key space the deals model joins on).
with object_states as (
    select
        s.object_id,
        s.tombstone,
        s.snapshot -> 'properties' as properties,
        r.payload ->> 'occurred_at' as occurred_at,
        r.received_at,
        r.event_id
    from ingest.hydrated_snapshots s
    join raw.raw_events r
      on r.tenant_id = s.tenant_id and r.event_id = s.event_id and r.source = 'hubcrm'
    where s.object_type = 'contact'
),
live_objects as (
    select distinct on (object_id)
        object_id, tombstone, properties, occurred_at, received_at, event_id
    from object_states
    order by object_id,
             ((occurred_at)::timestamptz) desc,
             received_at desc,
             event_id desc
),
latest as (
    select distinct on (properties ->> 'hs_manifest_id')
        properties
    from live_objects
    where not tombstone
    order by properties ->> 'hs_manifest_id',
             ((occurred_at)::timestamptz) desc,
             received_at desc,
             event_id desc
)
select
    properties ->> 'hs_manifest_id'      as contact_id,
    properties ->> 'company_manifest_id' as company_id,
    properties ->> 'name'                as name,
    properties ->> 'email'               as email
from latest
