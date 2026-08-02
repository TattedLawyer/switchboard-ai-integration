-- Scale bounds come from csat.recorded's min/max in ingest/src/numeric-contract.ts via
-- the EMITTED numeric_bounds seed (Wave 5) — not re-typed here. LEFT JOIN + the
-- missing-bound arm keep this invariant LOUD: if the csat bound row ever vanished from
-- the seed, every csat row would surface instead of the test going vacuously green.
-- NULL scores stay excluded when the bound is present — an unusable score is the L2
-- safe-cast's story (surfaced by null_score_count), not an out-of-scale value.
select c.csat_id, c.score
from {{ ref('stg_support__csat') }} c
left join {{ ref('numeric_bounds') }} b
  on b.event_type = 'csat.recorded' and b.field = 'score'
where b.event_type is null
   or c.score < b.scale_min
   or c.score > b.scale_max
