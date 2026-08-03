{{ config(severity='warn', store_failures=true) }}
-- Row-grain surface of the Unlikely Value flag (Wave 5): the ceiling is the contract's
-- plausibleMax, emitted as the numeric_bounds seed and derived ONCE in the staging
-- models' is_unlikely_amount — no bound is re-typed here (consistency-pinned in
-- ingest/test/numeric-bounds-seed.test.ts). WARN on purpose: a genuine large amount
-- must never fail a build; it must be looked at. Covers every staging surface with a
-- declared plausible bound: payments (charge.*) and invoices (invoice.finalized).
--
-- store_failures: the flagged rows are persisted so scripts/verify-dbt-warns.ts can pin
-- the warning's row IDENTITY against what this test itself recorded, rather than
-- re-deriving is_unlikely_amount from the models and agreeing with a broken test twice.
--
-- Severity/threshold config was CONSIDERED and rejected for the CI green criterion.
-- dbt's documented "assert an expected failure" idiom (error_if '<1' / warn_if '>1')
-- would make the CI fixture's permanent demonstration row stop warning and restore
-- WARN=0 — but severity is a PRODUCTION property of this test, and warn_if '>1' would
-- mean the first unlikely amount in a real deployment is silently ignored. The expected
-- warn is a fixture fact, so it is pinned in fixture-scoped machinery
-- (scripts/dbt-warn-contract.ts), not by weakening the surface everywhere.
select 'payment' as kind, payment_id as id, amount_cents
from {{ ref('stg_billing__payments') }} where is_unlikely_amount
union all
select 'invoice', invoice_id, amount_cents
from {{ ref('stg_billing__invoices') }} where is_unlikely_amount
