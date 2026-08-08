# ADR: Identity resolution — three deterministic tiers, no ML

**Status:** accepted (Phase 2a, implemented)
**Where it lives:** `warehouse/models/identity/` (`merge_edges`, `int_crm__canonical_companies`,
`identity_resolution`, `manual_review`) → `warehouse/models/marts/customer_360.sql`
**Verified by:** dbt data tests + `scripts/verify-identity.ts` (set-equality against the seed
manifest's planned match matrix, run in `demo.sh` and CI)

## Problem

Three systems (CRM, billing, support) describe overlapping real-world companies under
different IDs, name spellings, and domains. The unified `customer_360` mart needs one row
per real entity, which means deciding — defensibly — which records are the same company.

## Decision: three deterministic tiers, in strict precedence

| Tier | Rule | Evidence recorded |
|---|---|---|
| 1 | Exact email match: the external record's email equals a CRM contact email (or a company's `owner_email`) | `email=<the matching email>` |
| 2 | Normalized domain **and** normalized company name both match. Name normalization (Task F, pinned per-vector in both languages): NFC, invisible-character handling (ZWSP/NBSP), lowercase, `&`→`and`, whitespace collapse, one trailing legal suffix stripped (`Inc/LLC/Ltd/Corp/Co/PLLC`, optional comma/period), trailing punctuation stripped; domain: lowercase, strip leading `www.`. A match whose domain is a **free email provider** (seed `free_email_domains`) demotes to manual review with the provider named — freemail domains carry no company signal | `domain+name=<normalized pair>`, or `free-email domain=<provider> … manual review` |
| 3 | Unmatched → the entity lands in `manual_review` and gets its own provisional identity (`<source>:<id>`) — never silently guessed onto a CRM company | `unmatched` |

Lowest tier wins deterministically (a final `distinct on ... order by matched_tier` makes
precedence explicit even if an entity matches multiple tiers). Tier 2 is deliberately
conjunctive: a name match with the wrong domain, or a domain match with the wrong name,
stays in manual review — the seeded dataset includes both near-misses to prove the tiers
fail for the right reason.

### Why no ML / fuzzy scoring

- **Every resolution is auditable.** Each link records `matched_tier` + `match_evidence`,
  so "why did B-0012 land on company C-0012?" has a one-line answer a customer can check.
  A similarity score answers "0.87" — which is not an answer during an incident or an audit.
- **Failures are honest.** A deterministic system's unmatched set is exact and reviewable
  (`manual_review`); a probabilistic threshold converts unknowns into silent false merges,
  the single worst failure mode for a customer-of-record view.
- **The scale doesn't demand it.** Blocking-and-scoring earns its complexity at millions of
  rows with noisy free-text; at this dataset's width, deterministic rules cover every
  planned case and the residue is small enough for a human queue.

**The false-positive side, stated plainly.** The honesty argument above covers false
*negatives*: an unmatched entity lands in `manual_review` instead of being guessed. The
symmetric risk is a false *positive* — tier 1 over-merging two genuinely distinct
companies that share an email (the classic case: an outsourced bookkeeper's freemail
address on both companies' billing records). The guard (per-ENTITY since Task F's L2-G3
fix): when an entity's email evidence — one shared address, or several addresses across
its records — spans **more than one** distinct canonical company, the entity is demoted
to `manual_review` with the ambiguity recorded as evidence (`ambiguous email=... matched
N canonical companies`, or the cross-group form naming the conflicting counts) rather
than merged onto any. Tier 2's guard composes the same way over (domain, name) tuples. The residual risk is the single-candidate
collision — a shared email that happens to match exactly one CRM company while actually
belonging to a different real-world one. No deterministic rule can detect that from the
email alone; it is exactly the case the sampled human audit of resolved links (see the
[real-connector delta](../real-connector-delta.md)) exists to catch.

**The "at scale" comparison, for the record:** probabilistic record linkage is a mature
literature — the Fellegi–Sunter model (Fellegi & Sunter, *A Theory for Record Linkage*,
JASA, 1969) underpins modern open-source implementations such as
[Splink](https://github.com/moj-analytical-services/splink) (UK Ministry of Justice) and
[dedupe](https://github.com/dedupeio/dedupe). At millions of records that is the right
tool family; the migration path from here is incremental (the deterministic tiers become
high-confidence blocking rules feeding a scoring model, and `manual_review` becomes the
labeling queue). This mirrors the ingestion layer's Temporal comparison: build the simple
thing that is provably correct at this scale, name the tool you'd reach for at the next one.

## Merge handling

Real CRMs merge duplicate records and emit merge events; downstream identity must collapse
accordingly. Design (locked as amendment decision D5):

- **`merge_edges` is immutable and derived** — built from `company.merged` events in
  `raw.raw_events` (from_id → to_id; latest `occurred_at` wins per from_id, event-ordinal
  tiebreak). Raw is **never rewritten**; the edge set is a pure function of the append-only
  event history.
- **Resolution happens at mart build time only.** `int_crm__canonical_companies` walks each
  company follow-to-terminal through the edges. No stored canonical state to migrate or
  corrupt — rebuild and it's correct.
- **Batch recompute over full history makes arrival order wash out.** Transitive merges
  (A→B→C) resolve identically regardless of delivery order, because every build recomputes
  from the complete raw set. This property is stated in the model and exercised by tests.
- **Cycle guard + termination, tested.** The recursive walk carries its path, flags any
  revisited node (`is_cycle`), and bounds depth at 10. Two dbt singular tests —
  `assert_no_merge_cycles` and `assert_merge_chains_terminate` — gate every build; the
  cycle test was demonstrated failing against a live injected cycle before it was trusted.
- **Unmerge is explicitly out of scope** (D5): real CRMs barely support it, and modeling it
  would complicate the immutable-edges design for a case the source systems themselves
  handle poorly. If needed later, it arrives as a new event type and a re-derivation —
  the raw history already contains everything required.

Merged-away companies vanish from `customer_360` and their history re-points: the seeded
dataset stages 22 companies that collapse to 20 canonical entities, with the duplicates'
deals rolling up to the canonical row (open-deal conservation is asserted by the oracle).

## Provenance: the auditability deliverable

Every resolved link carries `resolution_key` (`<source>:<id>`), `resolved_entity_id`,
`matched_tier`, and `match_evidence`; every canonical company carries its `merge_path` and
`merge_depth`. Resolution is a queryable audit trail, not a black box — and
`scripts/verify-identity.ts` checks the entire assignment (every entity in exactly its
planned tier, full manual-review membership, merge collapse, deal conservation, mart
rowcount conservation) against the seed manifest on every demo run and CI build.

## Positioning (amendment D13)

`manual_review` — and the approval table that arrives with Phase 3's gated write action —
are Switchboard **operational** state, not a system of record. The source systems remain
the systems of record for customer data; Switchboard **reads from, never masters,
customer data**. Nothing in the identity layer writes back to any source, and nothing in
`manual_review` is a "seed" of truth — it is a work queue (a plain incremental table, not
a static dbt seed) whose disposition flow lands in a later phase.
