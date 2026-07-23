-- Plain incremental model (D5 explicitly: NOT a static-CSV dbt seed; D13: this is Switchboard
-- *operational* state, not a system of record). Unmatched (tier-3) entities accumulate here
-- with a stable first_seen_at; resolved entities simply stop being re-inserted.
{{ config(materialized='incremental', unique_key='resolution_key') }}
select
    resolution_key,
    source,
    source_entity_id,
    match_evidence,
    current_timestamp as first_seen_at
from {{ ref('identity_resolution') }}
where matched_tier = 3
{% if is_incremental() %}
  and resolution_key not in (select resolution_key from {{ this }})
{% endif %}
