-- Three-tier identity resolution with auditable provenance for billing, support, and
-- sheets entities.
-- Normalization is pinned HERE and only here (evidence strings make each resolution auditable).
-- Unit-tested by ingest/test/merge-resolution.test.ts (tiers/guards) and
-- ingest/test/sheet-mart-oracle.test.ts (the sheets arm), which load THIS file from disk
-- (loadModel, refs → fixture views) — edits here are exercised by those tests
-- automatically; there is no mirrored copy to keep in sync.
with canonical as (
    select company_id, canonical_id from {{ ref('int_crm__canonical_companies') }}
),
companies as (
    select c.company_id, c.name, c.domain, k.canonical_id
    from {{ ref('stg_crm__companies') }} c
    join canonical k on k.company_id = c.company_id
),
crm_emails as (
    -- Both arms are LATEST-STATE staging views (L2-G7): owner_email comes from
    -- stg_crm__companies, never a raw full-history scan — a replaced owner email must age
    -- out with the state that carried it, not remain tier-1 evidence forever.
    select email, company_id from {{ ref('stg_crm__contacts') }}
    union
    select owner_email as email, company_id
    from {{ ref('stg_crm__companies') }}
    where owner_email is not null
),
norm_companies as (
    select
        canonical_id,
        lower(regexp_replace(domain, '^www\.', '', 'i')) as norm_domain,
        regexp_replace(lower(trim(name)), '\s+(inc|llc|ltd|corp)\.?$', '') as norm_name
    from companies
),
sheets_clients as (
    -- sheets (A6): the fourth source. A sheet has no client entity id, so candidates
    -- key on staging's manufactured client_key ('email:<lower-trimmed addr>' /
    -- 'row:<row_key>' for rows with no usable email — each of those stays its own
    -- tier-3 manual-review entity below, never guessed into a merge).
    -- L2-G3 (register): a client whose rows carry differing name spellings is EXACTLY
    -- the multi-tuple straddle shape — collapse to ONE candidate tuple per client
    -- BEFORE the tiers see it, with the LATEST row's company as evidence. "Latest" uses
    -- staging's exposed recency (detected_at, received_at — the successor ordering's
    -- clocks) with row_key as a unique deterministic tail.
    -- Domain evidence derives from the email's own domain (sheets carry no domain
    -- column). Tier-2 is safe HERE because manifest-derived synthetic emails are
    -- corporate-domain; the free-email blocklist (gmail.com et al. would make domain
    -- evidence meaningless) remains Task F's gate before real data — see the deferred
    -- register; deliberately not built in this slice.
    -- client_name (the sheet's PERSON column) is deliberately NOT tier evidence
    -- (debt-burn C1; reason recorded in the A6 review): the tier-2 name predicate
    -- equates a candidate's name with a normalized CRM COMPANY name
    -- (norm_companies.norm_name). A person's name matching a company's is almost
    -- always coincidence — the sole-proprietor edge (a business trading under its
    -- owner's own name) is real, but rare enough on this evidence that including the
    -- column would manufacture far more false candidate evidence than the handful of
    -- true matches it could add. client_name still serves in customer_360's ORPHAN-NAMING path
    -- (company_name first, then client_name) — there it is a display label, not merge
    -- evidence, which is exactly the boundary.
    select distinct on (client_key)
        client_key,
        nullif(lower(trim(client_email)), '') as email,
        nullif(split_part(nullif(lower(trim(client_email)), ''), '@', 2), '') as domain,
        company_name as name
    from {{ ref('stg_sheets__rows') }}
    order by client_key, detected_at desc, received_at desc, row_key desc
),
source_entities as (
    select 'billing' as source, customer_id as source_entity_id, email, domain, name
    from {{ ref('stg_billing__customers') }}
    union all
    select distinct 'support', requester_id, requester_email, domain, company_name
    from {{ ref('stg_support__tickets') }}
    union all
    select 'sheets', client_key, email, domain, name from sheets_clients
),
tier1_candidates as (
    select se.source, se.source_entity_id, se.email, k.canonical_id
    from source_entities se
    join crm_emails ce on ce.email = se.email
    join canonical k on k.company_id = ce.company_id
),
-- Over-merge guard, PER ENTITY (L2-G3, Task F): tier 1 resolves only when ALL of the
-- entity's email evidence — every email, across every ticket/record it appeared on —
-- collapses to exactly ONE distinct canonical company. Grouping by entity alone (never
-- by (entity, email)) is the fix for the live-reproduced straddle: per-email groups let
-- a requester with two emails, each cleanly matching a DIFFERENT canonical, form two
-- clean count=1 groups and bypass every guard. min(email)/min(canonical_id) make the
-- surviving row deterministic; corroborating emails that agree stay resolvable.
tier1 as (
    select source, source_entity_id, min(canonical_id) as canonical_id,
           1 as matched_tier,
           case when count(distinct email) = 1
                then 'email=' || min(email)
                else 'email=' || min(email) || ' (+' || (count(distinct email) - 1)
                     || ' more, all one canonical)'
           end as match_evidence
    from tier1_candidates
    group by source, source_entity_id
    having count(distinct canonical_id) = 1
),
-- Email evidence spanning >1 distinct canonical company is AMBIGUOUS — whether one
-- shared/freemail-style address registered at two companies, or (the straddle) two
-- addresses each clean on their own. Picking a winner would be a silent false merge.
-- Route to manual review (tier 3) with auditable evidence; also barred from tier 2
-- below — conflicting email evidence makes any automatic merge suspect.
tier1_ambiguous as (
    select source, source_entity_id,
           source || ':' || source_entity_id as canonical_id,
           3 as matched_tier,
           case when count(distinct email) = 1
                then 'ambiguous email=' || min(email) || ' matched '
                     || count(distinct canonical_id) || ' canonical companies'
                else 'ambiguous email evidence: ' || count(distinct email)
                     || ' emails matched ' || count(distinct canonical_id)
                     || ' distinct canonical companies'
           end as match_evidence
    from tier1_candidates
    group by source, source_entity_id
    having count(distinct canonical_id) > 1
),
tier2_candidates as (
    select se.source, se.source_entity_id, nc.canonical_id, nc.norm_domain, nc.norm_name
    from source_entities se
    join norm_companies nc
      on nc.norm_domain = lower(regexp_replace(se.domain, '^www\.', '', 'i'))
     and nc.norm_name   = regexp_replace(lower(trim(se.name)), '\s+(inc|llc|ltd|corp)\.?$', '')
    where not exists (
        select 1 from tier1 t1
        where t1.source = se.source and t1.source_entity_id = se.source_entity_id
    )
    and not exists (
        select 1 from tier1_ambiguous ta
        where ta.source = se.source and ta.source_entity_id = se.source_entity_id
    )
),
-- Over-merge guard (mirrors tier 1), PER ENTITY (L2-G3): domain+name resolves only when
-- ALL of the entity's (domain,name) evidence tuples collapse to exactly ONE distinct
-- canonical company — merged duplicates share a canonical_id and still resolve, and a
-- requester whose tickets carry two tuples matching two DIFFERENT canonicals demotes
-- below instead of forming two clean per-tuple groups. min() keeps it deterministic.
tier2 as (
    select source, source_entity_id, min(canonical_id) as canonical_id,
           2 as matched_tier,
           'domain+name=' || min(norm_domain || '|' || norm_name) as match_evidence
    from tier2_candidates
    group by source, source_entity_id
    having count(distinct canonical_id) = 1
),
-- Domain+name evidence spanning >1 distinct canonical company is AMBIGUOUS — one tuple
-- shared by two canonicals, or (the straddle) two clean tuples pointing apart. Picking a
-- winner would be a silent false merge (DISTINCT ON previously kept an arbitrary,
-- plan-dependent row here). Route to manual review (tier 3) with auditable evidence.
tier2_ambiguous as (
    select source, source_entity_id,
           source || ':' || source_entity_id as canonical_id,
           3 as matched_tier,
           case when count(distinct (norm_domain, norm_name)) = 1
                then 'ambiguous domain+name=' || min(norm_domain || '|' || norm_name)
                     || ' matched ' || count(distinct canonical_id) || ' canonical companies'
                else 'ambiguous domain+name evidence: ' || count(distinct (norm_domain, norm_name))
                     || ' tuples matched ' || count(distinct canonical_id)
                     || ' distinct canonical companies'
           end as match_evidence
    from tier2_candidates
    group by source, source_entity_id
    having count(distinct canonical_id) > 1
),
matched as (
    select * from tier1 union all select * from tier2
    union all select * from tier1_ambiguous union all select * from tier2_ambiguous
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
