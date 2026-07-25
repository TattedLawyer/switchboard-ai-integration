-- Recursive follow-to-terminal with cycle guard.
-- Unit-tested by ingest/test/merge-resolution.test.ts, which loads THIS file from disk
-- (loadModel, refs → fixtures) — edits here are exercised by those tests automatically;
-- there is no mirrored copy to keep in sync.
with recursive walk as (
    select
        c.company_id            as company_id,
        c.company_id            as current_id,
        0                       as merge_depth,
        array[c.company_id]     as merge_path,
        false                   as is_cycle
    from {{ ref('stg_crm__companies') }} c
    union all
    select
        w.company_id,
        e.to_id,
        w.merge_depth + 1,
        w.merge_path || e.to_id,
        e.to_id = any(w.merge_path)
    from walk w
    join {{ ref('merge_edges') }} e on e.from_id = w.current_id
    where not w.is_cycle and w.merge_depth < 10
)
select distinct on (company_id)
    company_id,
    current_id  as canonical_id,
    merge_depth,
    merge_path,
    is_cycle
from walk
order by company_id, merge_depth desc
