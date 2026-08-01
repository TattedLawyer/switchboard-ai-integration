{{ config(severity='error') }}
-- Debt-burn C2: a sheets tier-3 orphan entity must carry the domain its own staged
-- email derives — the EXACT expression identity_resolution.sql pins for sheets domain
-- evidence (nullif(split_part(nullif(lower(trim(client_email)), ''), '@', 2), '')) —
-- and an orphan with no usable email ('row:'-keyed, or blank cells) must keep NULL,
-- never a guessed or fabricated domain. The expectation is RE-DERIVED from staging
-- independently of customer_360's own join (same structural pattern as
-- assert_no_mixed_currency_totals), so this also fails if the mart's derivation is
-- ever removed or drifts from the identity model's expression.
--
-- Free-email caveat carried from identity_resolution.sql's sheets arm: the derived
-- domain is only as meaningful as the email's domain — gmail.com et al. would make it
-- meaningless as EVIDENCE; the free-email blocklist remains Task F's gate. Here the
-- domain is a carried attribute on an unmerged (tier-3) entity, not merge evidence,
-- so the caveat travels with the column rather than blocking it.
--
-- Honesty note: the CI fixture seeds a deliberately CORRELATED universe (every sheet
-- email exists in CRM — ci-fixture.ts), so this test is vacuously green on the CI
-- gate's data; tier-3 orphans live in the fault-plan oracles. Its RED→GREEN evidence
-- was live-fired on a scratch DB with seeded orphan rows (debt-burn slice 3 report).
with sheet_orphans as (
    -- matched_tier = 3 covers both the unmatched and the ambiguity-demoted rows —
    -- the same population customer_360's external_only consumes.
    select r.resolved_entity_id as entity_id, r.source_entity_id as client_key
    from {{ ref('identity_resolution') }} r
    where r.source = 'sheets' and r.matched_tier = 3
),
expected as (
    -- max() mirrors external_only's aggregation; for 'email:'-keyed clients every row
    -- shares the same lower-trimmed email by client_key construction, and 'row:'-keyed
    -- clients derive NULL on every row, so the aggregate is well-defined either way.
    select o.entity_id,
           max(nullif(split_part(nullif(lower(trim(s.client_email)), ''), '@', 2), '')) as expected_domain
    from sheet_orphans o
    join {{ ref('stg_sheets__rows') }} s on s.client_key = o.client_key
    group by o.entity_id
)
select c.entity_id, c.domain as mart_domain, e.expected_domain
from {{ ref('customer_360') }} c
join expected e on e.entity_id = c.entity_id
where c.domain is distinct from e.expected_domain
