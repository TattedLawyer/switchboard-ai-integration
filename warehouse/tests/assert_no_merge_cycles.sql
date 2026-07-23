-- Singular test: rows returned = failure. A cycle in the merge graph (A→B→A) means the
-- walk was stopped by the cycle guard rather than reaching a terminal canonical id.
select company_id, merge_path
from {{ ref('int_crm__canonical_companies') }}
where is_cycle
