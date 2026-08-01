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
        -- Pinned normalization (Task F) — the SQL half of the TS↔SQL pair
        -- (mocks/core/src/normalize.ts normalizeCompanyName; change both or neither —
        -- ingest/test/normalizer-vectors.test.ts reds on drift, and verify-identity.ts
        -- makes the pair CI-load-bearing). Order: NFC → NBSP→space + zero-width deleted
        -- → lower → '&'→' and ' → collapse whitespace → trim → strip ONE trailing legal
        -- suffix (inc|llc|ltd|corp|co|pllc, optional leading comma / trailing period;
        -- single-strip on purpose, the idempotence caveat stands) → strip trailing
        -- commas/periods/spaces. The tier2_candidates join carries the identical
        -- expression over se.name — the per-vector tier-2 end-to-end test is the
        -- functional drift pin between the two copies.
        btrim(regexp_replace(regexp_replace(
            btrim(regexp_replace(
                replace(lower(translate(normalize(name, NFC),
                                        E'\u00A0\u200B\u200C\u200D\uFEFF', ' ')),
                        '&', ' and '),
                '\s+', ' ', 'g')),
            '[\s,]+(inc|llc|ltd|corp|co|pllc)\.?$', ''),
            '[\s,.]+$', '')) as norm_name
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
    -- column). The free-email blocklist (Task F) now gates this derived evidence like
    -- every other tier-2 domain: a free-provider domain (gmail.com et al.) demotes the
    -- match to manual review in tier2_free_demoted below rather than serving as merge
    -- evidence.
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
free_email_domains as (
    -- Task F blocklist (the register's before-tier-2-on-real-data gate). Research-
    -- verified rationale: free-provider domains carry no company-identity signal —
    -- HubSpot's company matching refuses freemail domains as company evidence
    -- (knowledge.hubspot.com/object-settings/automatically-create-and-associate-
    -- companies-with-contacts); provenance + curated-not-exhaustive caveat documented
    -- on the seed (warehouse/seeds/schema.yml).
    select domain from {{ ref('free_email_domains') }}
),
tier2_all_candidates as (
    select se.source, se.source_entity_id, nc.canonical_id, nc.norm_domain, nc.norm_name,
           exists (select 1 from free_email_domains f where f.domain = nc.norm_domain)
             as is_free_domain
    from source_entities se
    join norm_companies nc
      on nc.norm_domain = lower(regexp_replace(se.domain, '^www\.', '', 'i'))
     -- Identical normalization to norm_companies.norm_name (see the comment there) —
     -- kept as one expression per side so the model stays a pure SELECT.
     and nc.norm_name   = btrim(regexp_replace(regexp_replace(
            btrim(regexp_replace(
                replace(lower(translate(normalize(se.name, NFC),
                                        E'\u00A0\u200B\u200C\u200D\uFEFF', ' ')),
                        '&', ' and '),
                '\s+', ' ', 'g')),
            '[\s,]+(inc|llc|ltd|corp|co|pllc)\.?$', ''),
            '[\s,.]+$', ''))
    where not exists (
        select 1 from tier1 t1
        where t1.source = se.source and t1.source_entity_id = se.source_entity_id
    )
    and not exists (
        select 1 from tier1_ambiguous ta
        where ta.source = se.source and ta.source_entity_id = se.source_entity_id
    )
),
-- Free-provider evidence is NO-SIGNAL evidence (blocklist): it neither resolves nor
-- conflicts, so the guards below see only corporate-domain candidates — an entity with
-- one corporate match and one free match resolves on the corporate evidence instead of
-- reading the free match as a straddle.
tier2_candidates as (
    select source, source_entity_id, canonical_id, norm_domain, norm_name
    from tier2_all_candidates
    where not is_free_domain
),
-- A name+domain match whose domain is a free provider DID match — but on evidence that
-- carries no company signal (two unrelated "Smith Plumbing"s on gmail.com are the
-- textbook silent false merge). When that is ALL the tier-2 evidence an entity has, the
-- match goes to a human with the provider named, never to a silent tier-2 resolve and
-- never to a bare 'unmatched' that hides the fact a match occurred.
tier2_free_demoted as (
    select tac.source, tac.source_entity_id,
           tac.source || ':' || tac.source_entity_id as canonical_id,
           3 as matched_tier,
           'free-email domain=' || min(tac.norm_domain) || ' matched '
             || count(distinct tac.canonical_id)
             || ' canonical company(ies) — free-provider domains carry no company signal; manual review'
             as match_evidence
    from tier2_all_candidates tac
    where tac.is_free_domain
      and not exists (
        select 1 from tier2_candidates c
        where c.source = tac.source and c.source_entity_id = tac.source_entity_id
      )
    group by tac.source, tac.source_entity_id
),
-- Over-merge guard (mirrors tier 1), PER ENTITY (L2-G3): domain+name resolves only when
-- ALL of the entity's (domain,name) evidence tuples collapse to exactly ONE distinct
-- canonical company — merged duplicates share a canonical_id and still resolve, and a
-- requester whose tickets carry two tuples matching two DIFFERENT canonicals demotes
-- below instead of forming two clean per-tuple groups. min() keeps it deterministic.
tier2 as (
    select source, source_entity_id, min(canonical_id) as canonical_id,
           2 as matched_tier,
           -- Corroborating evidence is DISCLOSED, mirroring tier 1's marker shape
           -- (checklist line 6: records are equally rich across tiers — an auditor of a
           -- corroborated row sees the corroboration, not a single-tuple-looking string).
           case when count(distinct (norm_domain, norm_name)) = 1
                then 'domain+name=' || min(norm_domain || '|' || norm_name)
                else 'domain+name=' || min(norm_domain || '|' || norm_name)
                     || ' (+' || (count(distinct (norm_domain, norm_name)) - 1)
                     || ' more, all one canonical)'
           end as match_evidence
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
    union all select * from tier2_free_demoted
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
