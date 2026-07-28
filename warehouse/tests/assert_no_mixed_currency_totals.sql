{{ config(severity='error') }}
-- L5 invariant: a flagged mixed-currency entity must NEVER carry a money total — a sum
-- across two currencies is not a number. ERROR (not warn): any row here means the mart
-- emitted a confident cross-currency figure, which downstream consumers would trust.
select entity_id
from {{ ref('customer_360') }}
where has_mixed_currency
  and (total_invoiced_cents is not null
       or total_paid_cents is not null
       or open_deal_amount_cents is not null)
