-- The numeric_bounds seed's grain is COMPOUND — (event_type, field) — and core generic
-- tests have no compound unique, so the grain is pinned here as a singular test (repo
-- convention; dbt_utils.unique_combination_of_columns would buy the same detection for a
-- new package dependency this repo deliberately doesn't carry). Without this, a duplicate
-- seed row reds downstream as "payment_id not unique" — a misattributed failure two joins
-- away from the actual fault (Task G cold review Minor 1 named the repro). The seed is
-- generated, so a duplicate means the emitter or a hand-edit broke; this names it at the
-- seed, where the fix is.
select event_type, field, count(*) as n
from {{ ref('numeric_bounds') }}
group by event_type, field
having count(*) > 1
