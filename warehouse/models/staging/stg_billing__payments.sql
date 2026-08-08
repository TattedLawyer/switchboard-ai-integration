-- Re-sourced (F-1c): payments stage from the stripefeed charge family — the charge
-- object (data.object verbatim under payload.data) with the charge id as payment
-- identity and the event type's tail as status: charge.succeeded → succeeded,
-- charge.failed → failed (the same literals the mart already reads). Successor
-- ordering as everywhere (see stg_crm__companies.sql for the cast rationale).
with events as (
    select event_id, event_type, payload, received_at from raw.raw_events
    where source = 'stripefeed' and event_type in ('charge.succeeded', 'charge.failed')
),
latest as (
    select distinct on (payload -> 'data' ->> 'id')
        payload -> 'data' as charge,
        split_part(event_type, '.', 2) as status
    from events
    order by payload -> 'data' ->> 'id',
             ((payload ->> 'occurred_at')::timestamptz) desc,
             received_at desc,
             event_id desc
),
shaped as (
    select
        charge ->> 'id'          as payment_id,
        charge ->> 'invoice_id'  as invoice_id,
        charge ->> 'customer_id' as customer_id,
        -- L2 safe cast (see stg_billing__invoices.sql).
        case when pg_input_is_valid(charge ->> 'amount_cents', 'bigint')
             then (charge ->> 'amount_cents')::bigint end as amount_cents,
        status
    from latest
)
select
    s.payment_id,
    s.invoice_id,
    s.customer_id,
    s.amount_cents,
    s.status,
    -- Unlikely Value flag at row grain (Kimball #164, Wave 5): the ceiling is the
    -- contract's plausibleMax, arriving through the EMITTED numeric_bounds seed — never
    -- re-typed here (consistency-pinned in ingest/test/numeric-bounds-seed.test.ts).
    -- Above-bound rows are ACCEPTED and flagged for human attention, never dropped or
    -- quarantined at this layer. coalesce keeps the flag two-valued when the amount is
    -- NULL (that row's story is the L3 has_unusable_amounts machinery, not this flag)
    -- or when no bound is declared (absent seed row = no declared bound).
    coalesce(s.amount_cents > b.plausible_max, false) as is_unlikely_amount
from shaped s
left join {{ ref('numeric_bounds') }} b
  on b.event_type = 'charge.' || s.status and b.field = 'amount_cents'
