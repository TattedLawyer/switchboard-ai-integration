{{ config(severity='warn') }}
-- Row-grain surface of the Unlikely Value flag (Wave 5): the ceiling is the contract's
-- plausibleMax, emitted as the numeric_bounds seed and derived ONCE in the staging
-- models' is_unlikely_amount — no bound is re-typed here (consistency-pinned in
-- ingest/test/numeric-bounds-seed.test.ts). WARN on purpose: a genuine large amount
-- must never fail a build; it must be looked at. Covers every staging surface with a
-- declared plausible bound: payments (charge.*) and invoices (invoice.finalized).
select 'payment' as kind, payment_id as id, amount_cents
from {{ ref('stg_billing__payments') }} where is_unlikely_amount
union all
select 'invoice', invoice_id, amount_cents
from {{ ref('stg_billing__invoices') }} where is_unlikely_amount
