-- F-1c fix round (cold review I-3): merge-lineage conservation at the survivor end.
--
-- merge_edges translates company.merge events into business-key space through each
-- object's hydrated snapshot. The consumed-side miss is harmless by construction (an
-- object never hydrated while alive never staged, so nothing strands — argued in the
-- model header), but the SURVIVOR-side miss is not: if newObjectId has no translatable
-- snapshot (its hydration DLQ'd, or only a tombstone landed), the merge's edges drop
-- silently while both consumed companies keep staging from their pre-merge snapshots —
-- two separate stale canonicals, and every edge-keyed structural test stays green.
-- This test makes that named degraded state a RED BUILD: every company.merge event's
-- newObjectId must resolve to a non-tombstone company snapshot.
--
-- The object_manifest derivation is deliberately RE-STATED from merge_edges.sql (the
-- singular-test house rule — assert_canonical_targets_exist precedent: an expectation
-- computed by the code under test would follow that code into any regression).
with merge_events as (
    select
        event_id,
        payload -> 'data' ->> 'newObjectId' as new_object_id
    from raw.raw_events
    where source = 'hubcrm' and event_type = 'company.merge'
),
translatable_objects as (
    select distinct s.object_id
    from ingest.hydrated_snapshots s
    where s.object_type = 'company'
      and not s.tombstone
      and s.snapshot -> 'properties' ->> 'hs_manifest_id' is not null
)
select m.event_id, m.new_object_id
from merge_events m
left join translatable_objects t on t.object_id = m.new_object_id
where t.object_id is null
