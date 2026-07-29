{{ config(severity='error') }}
-- Cross-currency totals must never exist, checked PER SOURCE at the mart's own grain:
-- a source whose rows mix currencies must have NULL sums for that source; the other
-- source's sums are untouched (0 = no rows / genuine zero). Mixing is re-derived from
-- staging independently of the mart's has_mixed_currency flag, so this test also fails
-- if the mart's guard is ever removed. Bounds/semantics: ingest/src/numeric-contract.ts
-- is the numeric source of truth; currency semantics live in customer_360.sql (L5).
with billing_mixed as (
    select r.resolved_entity_id as entity_id
    from {{ ref('identity_resolution') }} r
    join {{ ref('stg_billing__invoices') }} i on i.customer_id = r.source_entity_id
    where r.source = 'billing'
    group by r.resolved_entity_id
    -- Not summable = more than one known currency, OR any NULL-currency row at all
    -- (count(distinct) alone ignores NULLs — F2). L5.1 retracted: this now includes
    -- uniformly-unknown entities — an unknown-unit total carried as money is an offender.
    having count(distinct i.currency) > 1
        or count(*) filter (where i.currency is null) > 0
),
deal_mixed as (
    select k.canonical_id as entity_id
    from {{ ref('stg_crm__deals') }} d
    join {{ ref('int_crm__canonical_companies') }} k on k.company_id = d.company_id
    group by k.canonical_id
    having count(distinct d.currency) > 1
        or count(*) filter (where d.currency is null) > 0
)
select c.entity_id, 'billing' as mixed_source, c.total_invoiced_cents, c.total_paid_cents, null::bigint as open_deal_amount_cents
from {{ ref('customer_360') }} c
join billing_mixed m on m.entity_id = c.entity_id
where c.total_invoiced_cents is not null or c.total_paid_cents is not null
union all
select c.entity_id, 'deals', null, null, c.open_deal_amount_cents
from {{ ref('customer_360') }} c
join deal_mixed m on m.entity_id = c.entity_id
where c.open_deal_amount_cents is not null
