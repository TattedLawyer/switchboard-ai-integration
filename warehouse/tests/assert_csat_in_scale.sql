-- Scale bounds mirror csat.recorded in ingest/src/numeric-contract.ts (1..5).
select csat_id, score from {{ ref('stg_support__csat') }} where score not between 1 and 5
