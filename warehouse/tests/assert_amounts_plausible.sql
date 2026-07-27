{{ config(severity='warn') }}
-- Plausibility ceiling (payments only; mirrors plausibleMax in ingest/src/numeric-contract.ts —
-- Stripe's 8-digit charge bound). WARN on purpose: a genuine large payment must never fail
-- a build; it must be looked at.
select payment_id, amount_cents from {{ ref('stg_billing__payments') }} where amount_cents > 99999999
