-- is_current contract: a manual_review_status row is current IFF the entity has no
-- tier-1/tier-2 resolution. Violations: resolved-but-still-current (stale flag) or
-- unresolved-but-marked-resolved (over-eager flag). Entities absent from
-- identity_resolution entirely (source data gone) are legitimately current — not joined,
-- not flagged here.
select s.resolution_key, s.is_current, ir.matched_tier
from {{ ref('manual_review_status') }} s
join {{ ref('identity_resolution') }} ir on ir.resolution_key = s.resolution_key
where (ir.matched_tier in (1, 2)) = s.is_current
