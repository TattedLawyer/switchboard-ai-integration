-- customer_360 (D6): one row per resolved canonical entity, unifying CRM + billing +
-- support + sheets through identity_resolution. Merged companies collapse into their
-- canonical and their deals roll up (the re-pointed-history proof). Entities present only
-- in billing, support, or a sheet (no CRM company) STILL get a row, flagged incomplete —
-- never hidden.
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
           -- Sheets evidence trails billing/support and prefers the org name over the
           -- person: company_name, then client_name — an orphan row is still NAMED,
           -- never a null-labelled mystery.
           max(coalesce(bc.name, st.company_name, sh.company_name, sh.client_name)) as entity_name,
           -- Debt-burn C2 (review M2): a sheets orphan's domain is derivable from its
           -- own email — the sh subquery derives it with the identity model's exact
           -- expression, so the two models' treatment of the same evidence cannot
           -- diverge. Sheets trails billing/support here too, matching the naming
           -- coalesce above. A 'row:'-keyed orphan (no usable email) derives NULL and
           -- keeps it — never guessed. Pinned by assert_sheet_orphan_domains_derived.
           max(coalesce(bc.domain, st.domain, sh.domain)) as domain
    from resolution r
    left join {{ ref('stg_billing__customers') }} bc
      on r.source = 'billing' and bc.customer_id = r.source_entity_id
    left join (select distinct requester_id, company_name, domain from {{ ref('stg_support__tickets') }}) st
      on r.source = 'support' and st.requester_id = r.source_entity_id
    -- The derived domain carries identity_resolution's free-email caveat verbatim:
    -- an email's domain is only as meaningful as its provider (gmail.com et al. carry
    -- no org signal); the free-email blocklist (Task F, wired at identity_resolution's
    -- tier 2) is what keeps such a domain out of MERGE evidence. Here it is a carried
    -- attribute on an unmerged tier-3 entity — displayed even for a free provider,
    -- pinned by the C2 companion in sheet-mart-oracle.test.ts.
    left join (select distinct on (client_key) client_key, company_name, client_name,
                      nullif(split_part(nullif(lower(trim(client_email)), ''), '@', 2), '') as domain
               from {{ ref('stg_sheets__rows') }}
               order by client_key, detected_at desc, received_at desc, row_key desc) sh
      on r.source = 'sheets' and sh.client_key = r.source_entity_id
    where r.matched_tier = 3
    group by r.resolved_entity_id
),
entities as (
    select entity_id, entity_name, domain, true as has_crm from crm_entities
    union all
    select entity_id, entity_name, domain, false from external_only
),
deals as (
    -- L5 summability predicate (mirrored in the billing CTE and in
    -- tests/assert_no_mixed_currency_totals.sql): a source's rows are summable iff at most
    -- one distinct KNOWN currency AND zero NULL-currency rows — i.e. exactly one known
    -- currency, or no rows at all (a true 0). L5.1 RETRACTED: uniformly-unknown currency
    -- also refuses — an unknown-unit total is not money (JD Edwards "hash totals", D365
    -- convert-or-filter, Stripe per-currency balances), and two unknown rows are not
    -- provably the same currency. is_mixed is the narrower flag condition: a KNOWN
    -- currency is contradicted (multiple knowns, or known + unknown — F2). All-unknown is
    -- refused-but-NOT-mixed: nothing known contradicts anything; the null_currency_*
    -- counters and NULL sums carry that story.
    select k.canonical_id as entity_id,
           count(*) filter (where d.status = 'open')                    as open_deal_count,
           count(*) filter (where d.currency is null)                   as null_currency_deal_rows,
           min(d.currency)                                              as deal_currency_raw,
           (count(distinct d.currency) <= 1
             and count(*) filter (where d.currency is null) = 0)        as deal_currency_is_single,
           (count(distinct d.currency) > 1
             or (count(distinct d.currency) = 1
                 and count(*) filter (where d.currency is null) > 0))   as deal_currency_is_mixed,
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
    -- Same L5 summability + mixed predicates as the deals CTE (L5.1 retracted — see there).
    -- Summable covers the no-invoice case: 0 distinct + 0 unknown rows → true 0. LEFT JOIN
    -- subtlety: a no-invoice entity has one null-extended row, so the NULL-currency counter
    -- (like the null_amount one) must guard on i.invoice_id is not null or "no invoices"
    -- would masquerade as "one unknown" and wrongly refuse the entity's true 0.
    select bl.entity_id,
           count(*) filter (where i.invoice_id is not null and i.currency is null)
                                                   as null_currency_invoice_rows,
           min(i.currency)                         as billing_currency_raw,
           (count(distinct i.currency) <= 1
             and count(*) filter (where i.invoice_id is not null and i.currency is null) = 0)
                                                   as billing_currency_is_single,
           (count(distinct i.currency) > 1
             or (count(distinct i.currency) = 1
                 and count(*) filter (where i.invoice_id is not null and i.currency is null) > 0))
                                                   as billing_currency_is_mixed,
           -- Raw sums; the final select NULLs them unless billing_currency_is_single (L5).
           sum(i.amount_cents)                     as total_invoiced_cents,
           sum(i.amount_cents) filter (where i.status = 'paid') as total_paid_cents,
           count(distinct i.invoice_id) filter (where i.status = 'created')    as open_invoice_count,
           count(*) filter (where i.invoice_id is not null and i.amount_cents is null) as null_amount_invoice_count,
           -- Wave 5: rows the staging Unlikely Value flag marked (above the contract's
           -- plausible ceiling, via the emitted numeric_bounds seed). The filter is
           -- NULL-safe on the LEFT JOIN's null-extended no-invoice row.
           count(*) filter (where i.is_unlikely_amount) as unlikely_amount_invoice_count
    from billing_link bl
    left join {{ ref('stg_billing__invoices') }} i on i.customer_id = bl.customer_id
    group by bl.entity_id
),
payments as (
    select bl.entity_id, count(*) filter (where p.status = 'failed') as failed_payment_count,
           -- Wave 5: same Unlikely Value roll-up as the billing CTE, payment side.
           count(*) filter (where p.is_unlikely_amount) as unlikely_amount_payment_count
    from billing_link bl
    join {{ ref('stg_billing__payments') }} p on p.customer_id = bl.customer_id
    group by bl.entity_id
),
sheets_link as (
    select r.resolved_entity_id as entity_id, r.source_entity_id as client_key
    from resolution r where r.source = 'sheets'
),
sheets as (
    -- Same L5 summability + mixed predicates as the deals/billing CTEs (L5.1 retracted —
    -- see the deals CTE). Sheet money lives in its OWN columns and NEVER folds into
    -- deal/invoice sums: a spreadsheet book of business is a fourth source, not extra
    -- deals. INNER join (contrast billing's LEFT JOIN subtlety): every sheets resolution
    -- row exists BECAUSE of a staged row, so there is no null-extended no-rows row to
    -- guard the counters against — no-rows entities simply have no CTE row (→ true 0 in
    -- the final select).
    select sl.entity_id,
           count(*)                                                     as sheet_row_count,
           count(*) filter (where s.currency is null)                   as null_currency_sheet_rows,
           min(s.currency)                                              as sheet_currency_raw,
           (count(distinct s.currency) <= 1
             and count(*) filter (where s.currency is null) = 0)        as sheet_currency_is_single,
           (count(distinct s.currency) > 1
             or (count(distinct s.currency) = 1
                 and count(*) filter (where s.currency is null) > 0))   as sheet_currency_is_mixed,
           -- Raw sum; the final select NULLs it unless sheet_currency_is_single (L5).
           sum(s.amount_cents)                                          as sheet_amount_cents,
           count(*) filter (where s.amount_cents is null)               as null_amount_sheet_count
    from sheets_link sl
    join {{ ref('stg_sheets__rows') }} s on s.client_key = sl.client_key
    group by sl.entity_id
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
           count(c.score)                              as csat_score_count, -- usable base under avg_csat
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
    (sh.entity_id is not null)                           as has_sheets,
    e.has_crm                                            as is_complete,
    coalesce(d.open_deal_count, 0)         as open_deal_count,
    -- L5 sum semantics: 0 = genuinely zero or no rows; NULL = not summable — currencies
    -- mixed (including known + unknown, F2) OR uniformly unknown (L5.1 retracted: unknown
    -- units are counted, never totaled). The no-rows case is handled explicitly (CTE row
    -- absent → 0, and an is_single source coalesces its empty sum to 0); a blanket
    -- coalesce would erase the NULL-when-not-summable signal.
    case when d.entity_id is null then 0
         when d.deal_currency_is_single then coalesce(d.open_deal_amount_cents, 0) end as open_deal_amount_cents,
    case when b.entity_id is null then 0
         when b.billing_currency_is_single then coalesce(b.total_invoiced_cents, 0) end as total_invoiced_cents,
    case when b.entity_id is null then 0
         when b.billing_currency_is_single then coalesce(b.total_paid_cents, 0) end     as total_paid_cents,
    coalesce(b.open_invoice_count, 0)      as open_invoice_count,
    coalesce(d.null_amount_deal_count, 0)    as null_amount_deal_count,
    coalesce(b.null_amount_invoice_count, 0) as null_amount_invoice_count,
    -- Addendum to F2: unknown-currency rows get a VISIBLE bucket, not just refusal —
    -- these count the NULL-currency rows behind a refused sum (any unknown row refuses).
    coalesce(b.null_currency_invoice_rows, 0) as null_currency_invoice_count,
    coalesce(d.null_currency_deal_rows, 0)    as null_currency_deal_count,
    -- Sheet contributions in their OWN columns (never folded into deal/invoice sums),
    -- under the SAME per-source machinery: 0 = no rows / genuine zero; NULL = not
    -- summable (mixed, or any unknown-currency row present — L5, F2, L5.1 retracted).
    coalesce(sh.sheet_row_count, 0)          as sheet_row_count,
    case when sh.entity_id is null then 0
         when sh.sheet_currency_is_single then coalesce(sh.sheet_amount_cents, 0) end as sheet_amount_cents,
    case when sh.sheet_currency_is_single then sh.sheet_currency_raw end as sheet_currency,
    coalesce(sh.null_amount_sheet_count, 0)  as null_amount_sheet_count,
    coalesce(sh.null_currency_sheet_rows, 0) as null_currency_sheet_count,
    -- L3: coalesce(sum(...), 0) renders "no amount" and "zero" identically; these counters
    -- make an entity with unusable amounts visibly incomplete instead of confidently zero.
    (coalesce(d.null_amount_deal_count, 0) + coalesce(b.null_amount_invoice_count, 0)
      + coalesce(sh.null_amount_sheet_count, 0)) > 0
                                             as has_unusable_amounts,
    -- L5: currency surfaced per source; NULL when not summable (mixed, known + unknown
    -- rows — F2 — or uniformly unknown) or when the entity has no invoices/deals.
    case when b.billing_currency_is_single then b.billing_currency_raw end as billing_currency,
    case when d.deal_currency_is_single   then d.deal_currency_raw   end as deal_currency,
    -- Deliberately NARROWER than "not summable": a uniformly-unknown source refuses its
    -- sums but is NOT mixed — nothing known contradicts anything. Its story is told by
    -- NULL sums + the null_currency_*_count columns (and the report's unknown-currency flag).
    (coalesce(b.billing_currency_is_mixed, false) or coalesce(d.deal_currency_is_mixed, false)
      or coalesce(sh.sheet_currency_is_mixed, false))                     as has_mixed_currency,
    coalesce(p.failed_payment_count, 0)    as failed_payment_count,
    coalesce(s.open_ticket_count, 0)       as open_ticket_count,
    coalesce(s.solved_ticket_count, 0)     as solved_ticket_count,
    coalesce(s.sla_breach_count, 0)        as sla_breach_count,
    c.avg_csat,
    -- F3 + addendum: avg_csat is the average of the usable scores only; csat_score_count
    -- is its base size and null_score_count discloses how many rows the average skipped.
    coalesce(c.null_score_count, 0)        as null_score_count,
    coalesce(c.csat_score_count, 0)        as csat_score_count,
    -- Wave 5 (Task G): Kimball's Unlikely Value flag, entity-rolled — rows whose amounts
    -- exceed the contract's plausible ceiling (flag derived at row grain in staging from
    -- the emitted numeric_bounds seed). Flagged for human attention, NEVER refused: the
    -- amounts stay in every sum above (pinned — flagged-is-not-refused, mart-currency).
    coalesce(p.unlikely_amount_payment_count, 0) as unlikely_amount_payment_count,
    coalesce(b.unlikely_amount_invoice_count, 0) as unlikely_amount_invoice_count,
    -- Kimball Design Tip #164 (audit dimension): ONE coarse warning — "tread cautiously" —
    -- with the precise columns above as the why. The OR of every honesty signal; extend it
    -- when a new signal lands (each trigger is pinned independently in mart-currency tests,
    -- so forgetting fails CI). Of Kimball's canonical audit flags: the Unlikely Value
    -- flag is LIVE since Wave 5 (the unlikely_amount_* terms below); the Data Supplied
    -- flag is deliberately absent — switchboard never imputes, it refuses, and the
    -- refusal is enforced machinery, not a slogan (assert_no_mixed_currency_totals +
    -- the L5 refusal pins in mart-currency.test.ts; the L3 missing-is-not-zero pins in
    -- mart-missing-vs-zero.test.ts) — an imputation-disclosure flag with no imputer
    -- would be dead surface; the Out-of-Bounds flag is deliberately absent AT THIS
    -- GRAIN because out-of-bounds values cannot REACH the mart — the ingest door
    -- quarantines them (L1) and the invariant tests assert_csat_in_scale +
    -- assert_amounts_non_negative red the build if that enforcement ever decays.
    (   (coalesce(d.null_amount_deal_count, 0) + coalesce(b.null_amount_invoice_count, 0)
          + coalesce(sh.null_amount_sheet_count, 0)) > 0
     or coalesce(b.billing_currency_is_mixed, false) or coalesce(d.deal_currency_is_mixed, false)
     or coalesce(sh.sheet_currency_is_mixed, false)
     or coalesce(b.null_currency_invoice_rows, 0) > 0 or coalesce(d.null_currency_deal_rows, 0) > 0
     or coalesce(sh.null_currency_sheet_rows, 0) > 0
     or coalesce(c.null_score_count, 0) > 0
     or coalesce(p.unlikely_amount_payment_count, 0) > 0
     or coalesce(b.unlikely_amount_invoice_count, 0) > 0
    )                                      as has_data_warnings
from entities e
left join deals d    on d.entity_id = e.entity_id
left join billing b  on b.entity_id = e.entity_id
left join payments p on p.entity_id = e.entity_id
left join support s  on s.entity_id = e.entity_id
left join csat c     on c.entity_id = e.entity_id
left join sheets sh  on sh.entity_id = e.entity_id
