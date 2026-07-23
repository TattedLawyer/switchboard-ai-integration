-- Current-status view over the append-only manual_review audit trail. manual_review is
-- grow-only by design (incremental insert, D13 audit trail): once an entity later resolves
-- (tier 1/2), its row stays but goes stale. Consumers read THIS view for live status:
-- is_current = the entity is STILL unresolved, i.e. has no tier-1/tier-2 row in
-- identity_resolution (which is rebuilt from current data every run). Derived, never
-- mutating the underlying audit rows.
{{ config(materialized='view') }}
with resolved as (
    select resolution_key
    from {{ ref('identity_resolution') }}
    where matched_tier in (1, 2)
)
select
    mr.resolution_key,
    mr.source,
    mr.source_entity_id,
    mr.match_evidence,
    mr.first_seen_at,
    (r.resolution_key is null) as is_current
from {{ ref('manual_review') }} mr
left join resolved r on r.resolution_key = mr.resolution_key
