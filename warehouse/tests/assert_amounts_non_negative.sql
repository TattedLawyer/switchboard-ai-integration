-- L4 detection: these sources are declared signed:false in ingest/src/numeric-contract.ts
-- (the single source of numeric rules). A negative here means L1 was relaxed or bypassed.
select 'invoice' as kind, invoice_id as id, amount_cents from {{ ref('stg_billing__invoices') }} where amount_cents < 0
union all
select 'payment', payment_id, amount_cents from {{ ref('stg_billing__payments') }} where amount_cents < 0
union all
select 'deal', deal_id, amount_cents from {{ ref('stg_crm__deals') }} where amount_cents < 0
