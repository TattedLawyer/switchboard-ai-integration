-- Re-sourced (F-1c): merge lineage now comes from hubcrm `company.merge` thin events —
-- the researched vendor shape (f2-wire-research.md Q1): `primaryObjectId` (the winner's
-- INPUT id), `mergedObjectIds` (the ids merged into it), and `newObjectId` (the NEW
-- record minted as the result — neither input survives under its own object id).
--
-- BOTH inputs map to the survivor: every id in mergedObjectIds AND primaryObjectId gets
-- an edge toward newObjectId, so the walk strands no id — the winner's old record is as
-- consumed as the merged-away one (its snapshot goes 404-stale; the survivor carries
-- hs_merged_object_ids naming both).
--
-- TRANSLATION (same commit as the staging identity decision — stg_crm__companies.sql):
-- staging keys companies by hs_manifest_id, so edges are TRANSLATED from the event's
-- objectId space into that key space via each object's latest hydrated snapshot. Two
-- consequences, both deliberate:
--   · the winner's translated edge is a SELF-edge (its business key IS the survivor's)
--     and is excluded — a self-edge would read as a cycle to the walk's guard while
--     saying nothing; the id it "maps" is already terminal.
--   · a consumed object that was never hydrated while alive has no snapshot and thus no
--     translatable edge — and by the same token it never staged, so no walk starts
--     there and nothing strands. (The fixture/demo pump cadence hydrates every object
--     within its creation cycle, so in the shipped compositions every edge translates.)
--
-- Still derived, deterministic, batch-recomputed over the full raw SET every build
-- (raw is never rewritten), and still one edge per from_id: latest merge event wins by
-- the successor ordering — occurred_at (timestamptz, L2-G2) desc, received_at desc,
-- event_id desc. Transitive chains resolve exactly as before; the D5 narrowing (a TRUE
-- occurred_at tie resolves by arrival) carries over unchanged.
with merge_events as (
    select
        payload -> 'data' ->> 'primaryObjectId' as primary_object_id,
        payload -> 'data' -> 'mergedObjectIds'  as merged_object_ids,
        payload -> 'data' ->> 'newObjectId'     as new_object_id,
        payload ->> 'occurred_at'               as occurred_at,
        event_id,
        received_at
    from raw.raw_events
    where source = 'hubcrm' and event_type = 'company.merge'
),
consumed as (
    select m.primary_object_id, m.new_object_id, m.occurred_at, m.event_id, m.received_at,
           x.consumed_object_id
    from merge_events m
    cross join lateral (
        select jsonb_array_elements_text(m.merged_object_ids) as consumed_object_id
        union all
        select m.primary_object_id
    ) x
),
object_manifest as (
    -- objectId → business key, via the object's latest non-tombstone snapshot (a
    -- business key never changes over an object's life, so any snapshot would do; the
    -- latest is taken for determinism under the same successor ordering).
    select distinct on (s.object_id)
        s.object_id,
        s.snapshot -> 'properties' ->> 'hs_manifest_id' as manifest_id
    from ingest.hydrated_snapshots s
    join raw.raw_events r
      on r.tenant_id = s.tenant_id and r.event_id = s.event_id and r.source = 'hubcrm'
    where s.object_type = 'company' and not s.tombstone
    order by s.object_id,
             ((r.payload ->> 'occurred_at')::timestamptz) desc,
             r.received_at desc,
             r.event_id desc
),
edges as (
    select f.manifest_id as from_id,
           t.manifest_id as to_id,
           c.occurred_at, c.event_id, c.received_at
    from consumed c
    join object_manifest f on f.object_id = c.consumed_object_id
    join object_manifest t on t.object_id = c.new_object_id
    where f.manifest_id is distinct from t.manifest_id
)
select distinct on (from_id) from_id, to_id, occurred_at
from edges
order by from_id, (occurred_at)::timestamptz desc, received_at desc, event_id desc
