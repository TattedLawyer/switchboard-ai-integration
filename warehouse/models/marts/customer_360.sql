-- customer_360 (D6): one row per resolved canonical entity, unifying CRM + billing + support
-- through identity_resolution. Merged companies collapse into their canonical and their deals
-- roll up (the re-pointed-history proof). Entities present only in billing or support (no CRM
-- company) STILL get a row, flagged incomplete — never hidden.
with canonical as (
    select company_id, canonical_id from {{ ref('int_crm__canonical_companies') }}
),
crm_entities as (
    select distinct on (k.canonical_id)
        k.canonical_id as entity_id, c.name as entity_name, c.domain
    from {{ ref('stg_crm__companies') }} c
    join canonical k on k.company_id = c.company_id
    order by k.canonical_id, (c.company_id = k.canonical_id) desc  -- canonical's own record names the entity
),
resolution as (
    select * from {{ ref('identity_resolution') }}
),
external_only as (
    select r.resolved_entity_id as entity_id,
           max(coalesce(bc.name, st.company_name)) as entity_name,
           max(coalesce(bc.domain, st.domain))     as domain
    from resolution r
    left join {{ ref('stg_billing__customers') }} bc
      on r.source = 'billing' and bc.customer_id = r.source_entity_id
    left join (select distinct requester_id, company_name, domain from {{ ref('stg_support__tickets') }}) st
      on r.source = 'support' and st.requester_id = r.source_entity_id
    where r.matched_tier = 3
    group by r.resolved_entity_id
),
entities as (
    select entity_id, entity_name, domain, true as has_crm from crm_entities
    union all
    select entity_id, entity_name, domain, false from external_only
),
deals as (
    -- L5/L5.1 single-currency predicate (mirrored in the billing CTE and in
    -- tests/assert_no_mixed_currency_totals.sql): a source's rows are single-currency iff
    -- the currency is UNIFORMLY unknown (0 distinct — pre-currency history stays summable,
    -- labeled NULL) or exactly one known currency with ZERO NULL-currency rows beside it.
    -- Known + unknown = MIXED: the unknown amount could be any currency, so the sum is
    -- refused like any other mix (count(distinct) alone ignores NULLs — external review F2).
    select k.canonical_id as entity_id,
           count(*) filter (where d.status = 'open')                    as open_deal_count,
           count(*) filter (where d.currency is null)                   as null_currency_deal_rows,
           min(d.currency)                                              as deal_currency_raw,
           (count(distinct d.currency) = 0
             or (count(distinct d.currency) = 1
                 and count(*) filter (where d.currency is null) = 0))   as deal_currency_is_single,
           -- Raw sum; the final select NULLs it unless deal_currency_is_single (L5).
           sum(d.amount_cents) filter (where d.status = 'open')         as open_deal_amount_cents,
           count(*) filter (where d.amount_cents is null)               as null_amount_deal_count
    from {{ ref('stg_crm__deals') }} d
    join canonical k on k.company_id = d.company_id
    group by k.canonical_id
),
billing_link as (
    select r.resolved_entity_id as entity_id, r.source_entity_id as customer_id
    from resolution r where r.source = 'billing'
),
billing as (
    -- Same L5/L5.1 predicate as the deals CTE. LEFT JOIN subtlety: a no-invoice entity has
    -- one null-extended row, so the NULL-currency counter (like the null_amount one) must
    -- guard on i.invoice_id is not null or "no invoices" would masquerade as "one unknown".
    select bl.entity_id,
           count(*) filter (where i.invoice_id is not null and i.currency is null)
                                                   as null_currency_invoice_rows,
           min(i.currency)                         as billing_currency_raw,
           (count(distinct i.currency) = 0
             or (count(distinct i.currency) = 1
                 and count(*) filter (where i.invoice_id is not null and i.currency is null) = 0))
                                                   as billing_currency_is_single,
           -- Raw sums; the final select NULLs them unless billing_currency_is_single (L5).
           sum(i.amount_cents)                     as total_invoiced_cents,
           sum(i.amount_cents) filter (where i.status = 'paid') as total_paid_cents,
           count(distinct i.invoice_id) filter (where i.status = 'created')    as open_invoice_count,
           count(*) filter (where i.invoice_id is not null and i.amount_cents is null) as null_amount_invoice_count
    from billing_link bl
    left join {{ ref('stg_billing__invoices') }} i on i.customer_id = bl.customer_id
    group by bl.entity_id
),
payments as (
    select bl.entity_id, count(*) filter (where p.status = 'failed') as failed_payment_count
    from billing_link bl
    join {{ ref('stg_billing__payments') }} p on p.customer_id = bl.customer_id
    group by bl.entity_id
),
support_link as (
    select r.resolved_entity_id as entity_id, r.source_entity_id as requester_id
    from resolution r where r.source = 'support'
),
support as (
    select sl.entity_id,
           count(*) filter (where t.status = 'open')   as open_ticket_count,
           count(*) filter (where t.status = 'solved') as solved_ticket_count,
           count(*) filter (where t.status = 'solved' and t.solved_at > t.sla_due_at) as sla_breach_count
    from support_link sl
    join {{ ref('stg_support__tickets') }} t on t.requester_id = sl.requester_id
    group by sl.entity_id
),
csat as (
    -- F3: score is nullable since the safe-cast and avg() skips NULLs — correct over the
    -- usable scores, but the skipped rows must be disclosed, not silently averaged around.
    select sl.entity_id,
           avg(c.score)::numeric(3,2)                  as avg_csat,
           count(*) filter (where c.score is null)     as null_score_count
    from support_link sl
    join {{ ref('stg_support__tickets') }} t on t.requester_id = sl.requester_id
    join {{ ref('stg_support__csat') }} c on c.ticket_id = t.ticket_id
    group by sl.entity_id
)
select
    e.entity_id,
    e.entity_name,
    e.domain,
    e.has_crm,
    (b.entity_id is not null or p.entity_id is not null) as has_billing,
    (s.entity_id is not null)                            as has_support,
    e.has_crm                                            as is_complete,
    coalesce(d.open_deal_count, 0)         as open_deal_count,
    -- L5 sum semantics: 0 = genuinely zero or no rows; NULL = currencies mixed (including
    -- known + unknown, F2) — a single total would be a lie. The no-rows case is handled
    -- explicitly (CTE row absent → 0, and an is_single source coalesces its empty sum to
    -- 0); a blanket coalesce would erase the NULL-when-mixed signal.
    case when d.entity_id is null then 0
         when d.deal_currency_is_single then coalesce(d.open_deal_amount_cents, 0) end as open_deal_amount_cents,
    case when b.entity_id is null then 0
         when b.billing_currency_is_single then coalesce(b.total_invoiced_cents, 0) end as total_invoiced_cents,
    case when b.entity_id is null then 0
         when b.billing_currency_is_single then coalesce(b.total_paid_cents, 0) end     as total_paid_cents,
    coalesce(b.open_invoice_count, 0)      as open_invoice_count,
    coalesce(d.null_amount_deal_count, 0)    as null_amount_deal_count,
    coalesce(b.null_amount_invoice_count, 0) as null_amount_invoice_count,
    -- L3: coalesce(sum(...), 0) renders "no amount" and "zero" identically; these counters
    -- make an entity with unusable amounts visibly incomplete instead of confidently zero.
    (coalesce(d.null_amount_deal_count, 0) + coalesce(b.null_amount_invoice_count, 0)) > 0
                                             as has_unusable_amounts,
    -- L5: currency surfaced per source; NULL when mixed (no single currency is true —
    -- including a known currency alongside unknown rows, F2) or when the entity has no
    -- invoices/deals carrying one (L5.1: uniformly-unknown sums stay labeled NULL).
    case when b.billing_currency_is_single then b.billing_currency_raw end as billing_currency,
    case when d.deal_currency_is_single   then d.deal_currency_raw   end as deal_currency,
    (not coalesce(b.billing_currency_is_single, true) or not coalesce(d.deal_currency_is_single, true))
                                                                          as has_mixed_currency,
    coalesce(p.failed_payment_count, 0)    as failed_payment_count,
    coalesce(s.open_ticket_count, 0)       as open_ticket_count,
    coalesce(s.solved_ticket_count, 0)     as solved_ticket_count,
    coalesce(s.sla_breach_count, 0)        as sla_breach_count,
    c.avg_csat,
    -- F3: csat rows whose score was unusable (NULLed by the safe-cast) — avg_csat is the
    -- average of the usable scores only, and this counter discloses how many it skipped.
    coalesce(c.null_score_count, 0)        as null_score_count
from entities e
left join deals d    on d.entity_id = e.entity_id
left join billing b  on b.entity_id = e.entity_id
left join payments p on p.entity_id = e.entity_id
left join support s  on s.entity_id = e.entity_id
left join csat c     on c.entity_id = e.entity_id
