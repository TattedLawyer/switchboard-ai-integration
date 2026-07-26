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
    select k.canonical_id as entity_id,
           count(*) filter (where d.status = 'open')                    as open_deal_count,
           coalesce(sum(d.amount_cents) filter (where d.status = 'open'), 0) as open_deal_amount_cents
    from {{ ref('stg_crm__deals') }} d
    join canonical k on k.company_id = d.company_id
    group by k.canonical_id
),
billing_link as (
    select r.resolved_entity_id as entity_id, r.source_entity_id as customer_id
    from resolution r where r.source = 'billing'
),
billing as (
    select bl.entity_id,
           coalesce(sum(i.amount_cents), 0)                                    as total_invoiced_cents,
           coalesce(sum(i.amount_cents) filter (where i.status = 'paid'), 0)   as total_paid_cents,
           count(distinct i.invoice_id) filter (where i.status = 'created')    as open_invoice_count
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
    select sl.entity_id, avg(c.score)::numeric(3,2) as avg_csat
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
    coalesce(d.open_deal_amount_cents, 0)  as open_deal_amount_cents,
    coalesce(b.total_invoiced_cents, 0)    as total_invoiced_cents,
    coalesce(b.total_paid_cents, 0)        as total_paid_cents,
    coalesce(b.open_invoice_count, 0)      as open_invoice_count,
    coalesce(p.failed_payment_count, 0)    as failed_payment_count,
    coalesce(s.open_ticket_count, 0)       as open_ticket_count,
    coalesce(s.solved_ticket_count, 0)     as solved_ticket_count,
    coalesce(s.sla_breach_count, 0)        as sla_breach_count,
    c.avg_csat
from entities e
left join deals d    on d.entity_id = e.entity_id
left join billing b  on b.entity_id = e.entity_id
left join payments p on p.entity_id = e.entity_id
left join support s  on s.entity_id = e.entity_id
left join csat c     on c.entity_id = e.entity_id
