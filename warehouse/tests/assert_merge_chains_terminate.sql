-- Singular test: a canonical id must have NO outgoing merge edge — otherwise the walk
-- stopped at the depth guard (a chain longer than 10, or an undetected anomaly).
select k.company_id, k.canonical_id
from {{ ref('int_crm__canonical_companies') }} k
join {{ ref('merge_edges') }} e on e.from_id = k.canonical_id
where not k.is_cycle
