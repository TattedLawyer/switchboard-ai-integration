-- Singular test: every canonical id must exist as a real CRM company. A merge event
-- targeting a nonexistent company would otherwise mint a "phantom canonical" — deals and
-- history roll up to an id no CRM record has, invisible to every other check
-- (cold/edge-review finding L2-G5). Cycle rows are excluded: a cycle's terminal id is
-- reported by assert_no_merge_cycles, not here.
select k.company_id, k.canonical_id
from {{ ref('int_crm__canonical_companies') }} k
left join {{ ref('stg_crm__companies') }} c on c.company_id = k.canonical_id
where not k.is_cycle
  and c.company_id is null
