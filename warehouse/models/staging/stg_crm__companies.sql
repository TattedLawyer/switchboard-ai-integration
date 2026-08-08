-- Re-sourced (F-1c): the CRM arm stages from the hubcrm thin-webhook + hydration
-- paradigm. Thin events in raw are METADATA-ONLY (D7), so state comes from
-- ingest.hydrated_snapshots — the fetch-time full records the hydration pump wrote —
-- while SEQUENCING still follows the successor discipline over the TRIGGERING event's
-- clocks: occurred_at (timestamptz, the L2-G2 cast — the hubcrm door normalizes the
-- vendor's ms-epoch occurredAt into ISO occurred_at and quarantines anything that
-- cannot carry one, so the cast is safe here exactly as it is on every other source),
-- then received_at, then event_id. Never fetch time alone, never delivery order.
--
-- IDENTITY DECISION (F-1c, deliberate): company_id is hs_manifest_id — the record's
-- cross-system business key — not the vendor's numeric objectId. HubSpot object ids are
-- surrogate and NOT merge-stable (a merge mints a NEW surviving record id; researched,
-- f2-wire-research.md Q1), and no other system ever references them: billing/support/
-- sheets evidence, deal linkage (company_manifest_id), and verify-identity's manifest
-- expectations all live in the business-key space. Staging on the business key is the
-- standard external-id pattern; the objectId-space merge lineage is resolved by
-- merge_edges (which translates merge events into this key space — see its header).
--
-- Two-level latest-state:
--   1. per OBJECT: the newest snapshot row decides whether the object is live (a
--      tombstone as the newest state = the store answered 404 — deleted or consumed by
--      a merge; either way the OBJECT no longer exists and contributes no state);
--   2. per company_id: among live objects claiming the same business key (a merge
--      survivor carries its winner's key; the script may also recycle a manifest
--      company as a fresh object), the newest state wins.
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
    where s.object_type = 'company'
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
        properties, received_at
    from live_objects
    where not tombstone
    order by properties ->> 'hs_manifest_id',
             ((occurred_at)::timestamptz) desc,
             received_at desc,
             event_id desc
)
select
    properties ->> 'hs_manifest_id' as company_id,
    properties ->> 'name'           as name,
    properties ->> 'domain'         as domain,
    -- Latest-state owner email (L2-G7 unchanged by the re-source): identity_resolution's
    -- crm_emails reads owner_email from HERE, so a replaced owner email ages out with
    -- the state that carried it.
    properties ->> 'owner_email'    as owner_email,
    received_at                     as last_event_at
from latest
