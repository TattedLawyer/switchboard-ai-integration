-- D6: an entity with no CRM presence must exist in the mart AND be flagged incomplete.
select entity_id from {{ ref('customer_360') }} where not has_crm and is_complete
union all
select entity_id from {{ ref('customer_360') }} where has_crm and not is_complete
