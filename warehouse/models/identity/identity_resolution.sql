-- Three-tier identity resolution with auditable provenance for billing and support entities.
-- Normalization is pinned HERE and only here (evidence strings make each resolution auditable).
-- SYNC NOTE: the tier CTEs are mirrored in ingest/test/merge-resolution.test.ts (TIER_SQL,
-- with ref()s swapped for tmp_ir_* tables and the canonical join pre-flattened). Keep the
-- normalization expressions and tier predicates in sync.
with canonical as (
    select company_id, canonical_id from {{ ref('int_crm__canonical_companies') }}
),
companies as (
    select c.company_id, c.name, c.domain, k.canonical_id
    from {{ ref('stg_crm__companies') }} c
    join canonical k on k.company_id = c.company_id
),
crm_emails as (
    select email, company_id from {{ ref('stg_crm__contacts') }}
    union
    select payload -> 'data' ->> 'owner_email' as email, payload -> 'data' ->> 'id' as company_id
    from raw.raw_events where source = 'crm' and event_type = 'company.updated'
),
norm_companies as (
    select
        canonical_id,
        lower(regexp_replace(domain, '^www\.', '', 'i')) as norm_domain,
        regexp_replace(lower(trim(name)), '\s+(inc|llc|ltd|corp)\.?$', '') as norm_name
    from companies
),
source_entities as (
    select 'billing' as source, customer_id as source_entity_id, email, domain, name
    from {{ ref('stg_billing__customers') }}
    union all
    select distinct 'support', requester_id, requester_email, domain, company_name
    from {{ ref('stg_support__tickets') }}
),
tier1 as (
    select se.source, se.source_entity_id, k.canonical_id,
           1 as matched_tier, 'email=' || se.email as match_evidence
    from source_entities se
    join crm_emails ce on ce.email = se.email
    join canonical k on k.company_id = ce.company_id
),
tier2 as (
    select se.source, se.source_entity_id, nc.canonical_id,
           2 as matched_tier,
           'domain+name=' || nc.norm_domain || '|' || nc.norm_name as match_evidence
    from source_entities se
    join norm_companies nc
      on nc.norm_domain = lower(regexp_replace(se.domain, '^www\.', '', 'i'))
     and nc.norm_name   = regexp_replace(lower(trim(se.name)), '\s+(inc|llc|ltd|corp)\.?$', '')
    where not exists (
        select 1 from tier1 t1
        where t1.source = se.source and t1.source_entity_id = se.source_entity_id
    )
),
matched as (
    select * from tier1 union all select * from tier2
),
tier3 as (
    select se.source, se.source_entity_id,
           se.source || ':' || se.source_entity_id as canonical_id,
           3 as matched_tier, 'unmatched' as match_evidence
    from source_entities se
    where not exists (
        select 1 from matched m
        where m.source = se.source and m.source_entity_id = se.source_entity_id
    )
)
-- The final DISTINCT ON + order by matched_tier makes tier precedence explicit even if an
-- entity somehow matches multiple tiers — lowest tier wins, deterministically.
select distinct on (source, source_entity_id)
    source,
    source_entity_id,
    source || ':' || source_entity_id as resolution_key,
    canonical_id as resolved_entity_id,
    matched_tier,
    match_evidence
from (select * from matched union all select * from tier3) u
order by source, source_entity_id, matched_tier
