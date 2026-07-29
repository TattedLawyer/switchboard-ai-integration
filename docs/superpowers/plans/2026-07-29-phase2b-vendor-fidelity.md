# Phase 2b — Vendor Fidelity: Phase Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. This is the PHASE plan: research verdicts, resolved decisions, task decomposition with interfaces and test obligations. Each task receives its own writing-plans-grade brief at dispatch, derived from this document — a task's implementer reads its brief, not this whole plan.

**Spec:** `docs/superpowers/specs/2026-07-22-phase2-amendment.md` §4 + Rev-2 decisions D1–D13.
**Status of Task 1 (connector seam):** COMPLETE and merged to `main` (`b1469d4`) — `Connector` interface with `catchUp`/`reconcile`, reconcile-first contract, both CLIs migrated, behavior-preserving, chaos-verified.
**Base:** branch `phase2b-connectors` off `main` @ `b6d1de3` (includes tenancy migration 006, durability scripts, migration tracking, and the full numeric-integrity stack).

---

## 1. Vendor research — verified with full primary-source reads (2026-07-29)

Every load-bearing contract fact below was read from the primary page this planning round, not carried from digests or prior sessions. Where a fact could not be primary-verified it is labeled.

### CRM paradigm — HubSpot-style thin webhooks ([webhooks guide](https://developers.hubspot.com/docs/api-reference/legacy/webhooks/guide))
- Payload fields, verbatim: `objectId` ("The ID of the object that was created, changed, or deleted"), `propertyName`/`propertyValue` ("only sent for property change subscriptions"), `eventId`, `subscriptionType`, `portalId`, `occurredAt` ("a millisecond timestamp"), `attemptNumber` ("Starting at 0"), `changeSource`.
- Batching: "Each request can contain up to 100 events."
- **Ordering: NOT guaranteed** — the guide says to use `occurredAt` for sequencing. This is a design input, not a caveat (see §2, tiebreak).
- Retries: "up to 10 times… spread out over the next 24 hours, with varying delays"; failure = connection failure, >5s timeout, or error status.
- Signature: SHA-256 over app-secret + raw body. Our mocks keep the repo's own per-source timestamped HMAC (D3) — the spec models vendor *contracts*, not vendor *auth* (spec §5); the delta goes in the connector ADR.
- Payloads are SPARSE by design (property-change events carry one property). The numeric contract's `required: false` mechanism (built and unit-pinned in the numeric-integrity wave) becomes load-bearing here.

### Billing paradigm — Stripe-style events feed ([Events API](https://docs.stripe.com/api/events), [List Events](https://docs.stripe.com/api/events/list))
- Retention, verbatim: "You can access events through the Retrieve Event API for **30 days**." Backfill beyond 30 days is structurally impossible on this paradigm — the phase's second honest data-loss boundary.
- List: `limit` "can range between 1 and 100, and the default is 10"; cursors `starting_after`/`ending_before` are object IDs; `has_more` boolean; `type`/`types` (≤20) filters.
- **Response ordering is not documented on the list page.** The connector must not depend on response order: drain by `has_more`, order downstream by `created` + tiebreak. (The 2026-07-26 note "reverse-chronological confirmed" could not be re-verified against the current page — treat as unconfirmed.)
- `has_more` termination replaces the spine's "empty page" inference — the bug class already fixed once at `f1e7ac4` gets a vendor-correct mechanism.

### Support paradigm — event-bus subscribe/replay ([event message durability](https://developer.salesforce.com/docs/platform/pub-sub-api/guide/event-message-durability.html))
- Retention, verbatim: "Salesforce stores platform events and change data capture events for **72 hours**."
- Replay IDs are **opaque** and "aren't guaranteed to be contiguous for consecutive events" — they are cursors, never ordinals, never arithmetic.
- "A subscriber can store a replay ID value and use it on resubscription to retrieve events that are within the retention window."
- **The stream can be RESET entirely**: "on rare occasions, the stream of retained events can be reset if the Salesforce org is moved to a new instance" — so cursor invalidation has TWO causes (age-out and reset), and the second can strike a cursor younger than 72h.
- EARLIEST/LATEST replay presets + expired-replay recovery guidance: corroborated via the [Subscribe RPC reference](https://developer.salesforce.com/docs/platform/pub-sub-api/references/methods/subscribe-rpc.html) surfaced in search (not full-read — the durability page is the primary anchor; the preset enum is verified at implementation time per the spec's re-verify rule).
- Modeled over HTTP/JSON per locked D12.

### Spreadsheet paradigm — Google Sheets as a source (verified 2026-07-27, this session, full reads)
- Row identity: developer metadata is row-attached and follows the row through insertions; deleted row ⇒ deleted metadata ([DeveloperMetadata API reference](https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets.developerMetadata)). Caps: 30,000 chars per sheet AND per spreadsheet ([metadata guide](https://developers.google.com/workspace/sheets/api/guides/metadata)).
- **"Script executions and API requests don't cause triggers to run"** — documented ([installable triggers](https://developers.google.com/apps-script/guides/triggers/installable)). Push (Apps Script `onEdit`/`onChange` → webhook) is therefore a latency optimization only; **periodic reconcile is the primary channel** — exactly the seam's reconcile-first contract, already encoded in `connectors/types.ts`.
- Quotas: 300 read req/min/project, 60/min/user, 429 + documented exponential backoff ([limits](https://developers.google.com/workspace/sheets/api/limits)).
- Access: share the sheet with a service account's client_email — no OAuth flow ([gspread docs](https://docs.gspread.org/en/latest/oauth2.html)).
- Script Properties are readable by any sheet editor (any editor can edit the bound script; corroborated by [Google Workspace DevRel](https://dev.to/googleworkspace/secure-secrets-in-google-apps-script-1dhc)) ⇒ per-sheet low-trust secrets that authenticate "I am sheet X" and authorize nothing; the ingest treats sheet events as untrusted regardless (quarantine + contract).
- No event_id, no occurred_at, rows mutate in place ⇒ idempotency is **manufactured**: stable row key (developer metadata) + content hash; `occurred_at` is stamped at detection and flagged as derived.
- Five behaviors remain deliberately unverified and are each pinned by a test in-task, never assumed: real metadata ceiling; metadata across sheet duplication; installable-trigger queue depth under bulk edits; `onEdit` oldValue behavior on multi-cell paste; trigger daily-quota behavior under sustained editing.

---

## 2. Design consequences the research forces

1. **The latest-state tiebreak successor (register LANDMINE, owned by Task C).** No vendor id is ordinal: HubSpot `eventId` is opaque with ordering explicitly not guaranteed, Stripe `evt_…` ids are opaque, Salesforce replay IDs are non-contiguous, Sheets has no ids at all. The `(substring(event_id from 5))::bigint` tiebreak dies with the faithful sources; its successor is `order by occurred_at desc, received_at desc, event_id desc` — deterministic, vendor-agnostic, and honest (received_at is our clock, event_id lexicographic is a pure tiebreak). Per-source `occurred_at` normalization: HubSpot ms-epoch, Stripe s-epoch, bus event time, Sheets detection-time (derived). The legacy mocks keep evt-N ids until D9 retirement; the successor ordering must produce IDENTICAL latest-state for them (pin with a test) so the swap is behavior-preserving on 2a data.
2. **Two data-loss boundaries, both built, both chaos-injected (resolves spec open question 3 — recommend BUILD).** Bus: replay cursor invalid (aged-out past 72h or stream reset) → detect → fall back EARLIEST/LATEST by config → report an **unclosable gap** with bounds. Billing: backfill target older than 30 days → report the unreachable range. The pipeline's first admitted losses — reported, never papered over. `KNOWN-ISSUES` gets both as stated limits; chaos gets fault modes for both.
3. **Sparse payloads are the CRM norm.** The contract's `required` flag flips per event type for the faithful CRM source; hydration supplies the full record; the numeric gate applies to the HYDRATED snapshot too (a hydrated record is still vendor data).
4. **Reconcile-first is now uniform.** Sheets (triggers blind to API writes), bus (replay window), billing (30-day cap), CRM (10-retries-then-gone): every paradigm's push/stream channel is lossy on its own terms; every connector's `reconcile()` is the guarantee. The seam anticipated this; the tasks prove it per paradigm.

---

## 3. Decisions

**Locked (spec Rev-2, unchanged):** D12 event-bus over HTTP/JSON. D7 hydration into a separate `(event_id, fetched_at)` table with the thin event stored as received. D8 bus source = Service-Cloud-cases-shaped support. D9 old CRM mock retires at 2b exit after the chaos harness ports. D13 positioning.

**Resolved this plan (Michael 2026-07-29: "research thoroughly… then fully plan"):**
- **Sequencing: Sheets connector first** (after the already-done seam). It has a real prospect shape behind it, it is the hardest paradigm (stress-tests the seam worst-case first), and it is the most distinctive artifact in the repo.
- **Cursor-expiry handling: BUILD** (consequence 2 above).

**Open — Michael's call, recommendations attached:**
- **OQ-1 Vertical profiles.** D10 locked `plumbing | saas | logistics`. Recommendation: **swap `logistics` → `realestate`** — same cost, and the demo then speaks the language of the real prospect class this phase's Sheets work serves. (Amends D10; needs your yes.)
- **OQ-2 Text-first raw + claim-check enqueue.** Register-confirmed as the designed end-state for the raw layer. Recommendation: **explicitly re-defer to Phase 4.** 2b is already seven tasks; the defect class it dissolves (jsonb-unstorable payloads) is contained by the existing quarantine machinery, and doing the migration mid-2b couples two large reworks. Deferring is a scope decision to make loudly, not silently — hence this line. (If you'd rather pay it now, it becomes Task H after the connectors.)

---

## 4. Task decomposition

Single-flight, one implementer at a time, RED→GREEN pairs, Gates A–H (including the cold unframed review before every push). Each task's dispatch brief carries: its slice of §1–§2, exact interfaces, its debt items, and its test obligations.

**Task A — Google Sheets source + connector** *(first; the phase's centerpiece)*
- Mock: an HTTP "Sheets service" modeling the API subset (values read, developer metadata, 429 injection) plus a **simulated human editor** with fault plans: in-place edits, row inserts/deletes, header rename, blank rows, free-hand dates, garbage currency, bulk paste. The sheet's row set is the reconciliation truth (the ledger-equivalent for this paradigm).
- Connector (`kind: "sheet-snapshot"`): snapshot read → row-key via metadata (mock-side) → content-hash diff → derived events (`sheet.row_upserted`/`sheet.row_deleted` with detection-time `occurred_at`, derived event_id `sha-…`) → ingest through the standard door (contract, quarantine, idempotency all apply). `reconcile()` = full snapshot-diff against `raw` latest-state — the primary channel, per §1.
- Contract extension: **string rules** (`pattern`, required/optional) so cell-level garbage (currency, dates) quarantines with named reasons at the door — this is Wave 5's currency-at-the-door item landing in its natural home, with the count-presence trade documented from the register.
- Debt folded in: C4 quarantine attempt tracking + C2 `FOR ROLE` (this task's migration carries both).
- Oracle: after any fault-plan run, sheet rows ⇄ mart rows reconcile exactly; every rejected cell has a quarantine row naming the field.
**Task B — Billing: Stripe-faithful feed** — envelope mock (`data.object`, `evt_…` ids, `created`), cursor pagination with `has_more` termination, 30-day boundary reporting, feed-supplied-cursor skip-forward fix, poll fetch timeout (L1-G4, `AbortSignal`).
**Task C — CRM: thin-webhook + hydrate** — batched (≤100) sparse events, hydration connector with rate budget + hydration DLQ, D7 snapshot table + tombstones, second oracle (every thin event → snapshot or DLQ, nothing in limbo), **evt-N cast removal + tiebreak successor** (consequence 1) with the 2a-identical-latest-state pin.
**Task D — Support: bus subscribe/replay** — subscription lifecycle, replay-cursor persistence, cursor-invalid (age + reset) → fallback → **unclosable-gap report**, ledger seq enforcement (L1-G7), chaos fault: cursor expiry mid-run.
**Task E — Vertical seed profiles** (pending OQ-1) — generator `profile` param content; README screenshot trio.
**Task F — Old-CRM retirement (D9)** — chaos harness ports to the faithful CRM mock; legacy mock + evt-N remnants deleted; free-email blocklist + normalizer hardening land here (the register's before-tier-2-on-real-data gate) since retiring the mock touches the seed/identity fixtures anyway.
**Task G — Wave 5 remainder** — bound-emission design decision (contract → dbt, no third hand-copy), unlikely-value row flag folded into `has_data_warnings`, declared-absence enforcement citations.
**Close** — full gauntlet, three-lens panel, Gate E register sweep, Gate H cold review, PR (merge commit, Michael merges).

Dependencies: A → (B, C, D in any order, single-flight) → E/F/G → Close. Shared-crypto-package debt: fold into whichever of B/C/D first touches both signing copies; migration tracking is already on `main`.

## 5. Risks (inherited + new)
1. Task C touches the hardened ingest path → new-source-alongside rule; chaos green throughout (spec §6, unchanged).
2. Sheets trigger-side unknowns (five pinned tests, §1) may force design adjustments — they are scheduled FIRST inside Task A so surprises land before the connector shape freezes.
3. Effort: spec said 3–4 weekends; 2a's precedent says treat that as the floor and budget for hardening waves.
4. Scope creep toward the engagement: the wall holds — repo stays synthetic; profile content is generic vertical language, never client data.
