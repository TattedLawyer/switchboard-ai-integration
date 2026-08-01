-- Re-sourced (F-1c) from hubcrm hydrated snapshots — see stg_crm__companies.sql for the
-- paradigm and ordering rationale. deal_id = hs_manifest_id; company linkage is
-- company_manifest_id (business-key space — vendor object ids appear in no other
-- system). Deleted deals (the script's slot-8/9 create-then-delete pair) surface here
-- as objects whose newest snapshot is a TOMBSTONE and are excluded: the object no
-- longer exists at the source, so it contributes no staged state.
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
    where s.object_type = 'deal'
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
    properties ->> 'hs_manifest_id'      as deal_id,
    properties ->> 'company_manifest_id' as company_id,
    properties ->> 'name'                as name,
    -- L2 safe cast unchanged in spirit: hydrated records are vendor-faithful STRING
    -- properties (amount_cents arrives as a digit string on this surface — the
    -- hubcrm.deal.snapshot contract's ^\d{1,15}$ is the door-side enforcement), and
    -- anything that never passed the contract degrades to NULL here, never kills the
    -- build. NULLs stay visible downstream (L3/L4).
    case when pg_input_is_valid(properties ->> 'amount_cents', 'bigint')
         then (properties ->> 'amount_cents')::bigint end as amount_cents,
    -- L5: currency carried, not discarded; constrained to a three-letter uppercase code
    -- at the source. The script's currency-CLEAR (propertyValue null) surfaces here as
    -- NULL — "unknown", counted and refused by the mart, never summed.
    case when (properties ->> 'currency') ~ '^[A-Z]{3}$'
         then properties ->> 'currency' end as currency,
    properties ->> 'status'              as status
from latest
