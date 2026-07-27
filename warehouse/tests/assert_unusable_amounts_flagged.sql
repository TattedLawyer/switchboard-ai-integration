{{ config(severity='warn') }}
-- Surfaces entities whose sums exclude unusable (NULL) amounts. WARN: the mart stays
-- usable; the number is just visibly incomplete rather than silently smaller.
select entity_id, null_amount_invoice_count, null_amount_deal_count
from {{ ref('customer_360') }} where has_unusable_amounts
