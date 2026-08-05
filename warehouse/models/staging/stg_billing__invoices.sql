-- Re-sourced (F-1c): invoices stage from the stripefeed envelope feed's own vocabulary
-- and are RE-SHAPED onto the warehouse's invoice surface:
--   · invoice.finalized carries the invoice object (data.object verbatim under
--     payload.data — the connector's door mapping);
--   · payment state lives on the CHARGE family on this feed, so status derives from it:
--     an invoice with a charge.succeeded is 'paid'; a finalized invoice with no
--     successful charge stays 'created' — the warehouse's open-invoice state, kept
--     under the existing vocabulary so the mart's rollups are untouched. 'voided' is
--     unreachable on this feed (no void event modeled) and simply never appears.
-- Successor ordering as everywhere (see stg_crm__companies.sql for the cast rationale).
with events as (
    select event_id, payload, received_at from raw.raw_events
    where source = 'stripefeed' and event_type = 'invoice.finalized'
),
latest as (
    select distinct on (payload -> 'data' ->> 'id') payload -> 'data' as invoice
    from events
    order by payload -> 'data' ->> 'id',
             ((payload ->> 'occurred_at')::timestamptz) desc,
             received_at desc,
             event_id desc
),
paid_invoices as (
    select distinct payload -> 'data' ->> 'invoice_id' as invoice_id
    from raw.raw_events
    where source = 'stripefeed' and event_type = 'charge.succeeded'
),
shaped as (
    select
        invoice ->> 'id'          as invoice_id,
        invoice ->> 'customer_id' as customer_id,
        -- L2 safe cast: raw rows that never passed the ingest door must degrade to
        -- NULL, not kill the whole build (blast-radius containment; L1 is the
        -- enforcement). NULLs stay visible downstream (L3/L4).
        case when pg_input_is_valid(invoice ->> 'amount_cents', 'bigint')
             then (invoice ->> 'amount_cents')::bigint end as amount_cents,
        -- L5: currency carried, not discarded; constrained to MEMBERSHIP in the
        -- generated ISO-4217 seed (#37) — never a re-typed rule. Anything else, malformed
        -- or merely fictional, becomes NULL ("unknown": counted by the mart and refused
        -- from its totals, never summed). The door enforces the same list from the same
        -- vendored source; this is blast-radius containment for rows that reached raw
        -- another way (backfill, direct insert, history predating the rule).
        case when (invoice ->> 'currency') in (select currency_code from {{ ref('iso_4217_currencies') }})
             then invoice ->> 'currency' end as currency
    from latest
)
select
    s.invoice_id,
    s.customer_id,
    s.amount_cents,
    s.currency,
    case when p.invoice_id is not null then 'paid' else 'created' end as status,
    -- Unlikely Value flag at row grain (Kimball #164, Wave 5): the contract's
    -- plausibleMax for invoice.finalized, via the EMITTED numeric_bounds seed — never
    -- re-typed here (see stg_billing__payments.sql for the full rationale; the flag
    -- accepts and surfaces, never drops; NULL amounts stay false — L3's story).
    coalesce(s.amount_cents > b.plausible_max, false) as is_unlikely_amount
from shaped s
left join paid_invoices p on p.invoice_id = s.invoice_id
left join {{ ref('numeric_bounds') }} b
  on b.event_type = 'invoice.finalized' and b.field = 'amount_cents'
