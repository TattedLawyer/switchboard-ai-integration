# ADR: Four connector paradigms on one reliability spine

**Status:** accepted (Phase 2b, implemented)
**Where it lives:** `mocks/sheets`, `mocks/stripefeed`, `mocks/hubcrm`, `mocks/casebus`
(the vendor-shaped sources) → `ingest/src/connectors/` (the connector seam:
`catchUp` / `reconcile` per paradigm) → the unchanged ingest spine
(`/webhooks/:source`, `raw.raw_events`, pg-boss queues + DLQs, `ingest.quarantine`,
`ingest.cursors`, `ingest.gap_ledger`)
**Verified by:** each paradigm's own oracle suite (`ingest/test/sheet-oracle.test.ts`,
`sheet-mart-oracle.test.ts`, `bus-replay-oracle.test.ts`, the stripefeed and hubcrm
reconcile suites), `scripts/demo.sh`'s four-paradigm reconcile pass, and
`scripts/chaos.sh` for the fault-injected lanes

## Problem

A pipeline that integrates one vendor proves very little. The interesting question
for a business is whether the *next* integration is cheap — and that depends on
whether the reliability machinery underneath is vendor-shaped or paradigm-shaped.

So Phase 2b asked: pick the small number of ways real systems actually announce
change, implement all of them against the spine already built in Phases 1–2a, and
see what has to move. The answer that matters is the negative one: **the spine did
not change.** What changed is a per-source connector and, in two cases, an honest
admission that data can be lost.

## Decision: four paradigms, one seam, one loss vocabulary

| Paradigm | Source | Modelled on | Catch-up mechanism | Reconciliation truth |
|---|---|---|---|---|
| Spreadsheet snapshot-diff CDC | `sheets` | Google Sheets + Apps Script triggers | full-grid `GET /snapshot`, diffed against raw-derived state | the sheet's own current rows |
| Cursor-paged envelope feed | `stripefeed` | Stripe `/v1/events` | opaque cursor + `starting_after` / `has_more` drain | the feed's currently retained window |
| Thin webhook + hydration | `hubcrm` | HubSpot webhooks + object API | push-first; `backfill` is a *hydration pump* that fetches each thin event's object | the object store's own listings |
| Subscribe / replay event stream | `casebus` | Salesforce Pub/Sub API | subscribe from a stored replay id | the bus's retained window |

Every source terminates in the same `raw.raw_events` under
`(tenant_id, source, event_id)` exactly-once storage, the same quarantine for
malformed data, the same per-source DLQs, and the same identity layer. A fifth
paradigm — the 2a seq-ordered ledger feed (`billing`, `support`) — is retained
deliberately as the *test oracle*: it is the one shape real vendors do not offer,
so it is used to prove the spine under injected faults rather than to make claims
about vendors.

### The loss vocabulary is shared, because losing data is normal

Two of the four paradigms can lose data permanently by the vendor's design. Rather
than let each connector invent its own language for that, all admitted losses go to
one durable table (`ingest.gap_ledger`, migration 010) with a cause, bounds, a
detection time and an acknowledgement column; reconcile **fails while a gap is
unacknowledged** and passes once a named operator accepts it, still printing the
gap on every subsequent run. Acknowledging is not closing. The alternative designs
were both rejected: a permanent red is a red people learn to skip, and a silent
pass is the failure this project exists to refuse.

## Why each mock is faithful to a documented vendor behavior

Fidelity here means *the behavior the vendor documents*, read on the vendor's own
pages, not the behavior we found convenient. The research is in the repo and is
where the primary-source citations live:

- **`.superpowers/sdd/f2-wire-research.md`** — HubSpot merge semantics and
  Salesforce Case CDC, every claim read on the cited primary page (HubSpot generic
  and unified webhook guides, the merge-records knowledge base article, the object
  APIs guide; Salesforce Pub/Sub API and Case object reference, v252.0), with
  anything not directly source-stated tagged `(inference)`.
- **`.superpowers/sdd/task-B-report.md` / `task-D-report.md`** — the retention
  windows and error contracts (Stripe's documented error codes and pagination
  contract; the Salesforce Pub/Sub durability, error-handling and `subscribe` RPC
  pages for the 72-hour window, the single corrupted-replay-id error code, and the
  stream-reset language).
- **`.superpowers/sdd/debt-burn-research.md`** and
  **`.superpowers/sdd/close-fix-research.md`** — the non-vendor primary sources
  behind connector behavior decisions (AWS SDK retry classification for
  transient-vs-permanent probe failures, AWS CLI pagination for drain-by-default,
  Google AIP-180 for not removing a public report field, PostgreSQL advisory-lock
  and default-privilege semantics, RFC 9110).

What each mock takes from that, concretely:

**`hubcrm` (thin webhook + hydration).** Batches of up to 100 metadata-only events
per request, ordering not guaranteed, 10 retries over 24 hours and then the
delivery is gone — so the full record must be fetched afterwards, and a
notification that exhausts its retries is *unrecoverable*, since this paradigm has
no feed to re-read. Merge is a distinct event type carrying identifiers only, and
a merge mints a **new** record id carrying `hs_merged_object_ids`; neither input
survives under its own id. The connector's `merge_edges` therefore point both
inputs at the new survivor.

**`stripefeed` (cursor-paged envelope feed).** A 30-day retained window with an
opaque cursor; a cursor that falls out of the window is answered with the
documented `resource_missing` rejection. The connector falls back to the earliest
retained event so forward progress is never held hostage, and reports the
unreachable range as an unclosable gap with bounds. Response ordering is
undocumented, so the mock shuffles by default and the connector is order-blind.

**`casebus` (subscribe / replay).** A 72-hour retention window and — the detail
that drove the design — a *single* documented error code covering two different
causes: a replay id that aged out, and a stream that was reset when the org moved
instances (which can kill a cursor seconds old). Since the vendor will not tell
you which happened, the connector stores the stream identity alongside the cursor
(`ingest.cursors.stream_id`) and derives the cause structurally. At-least-once
delivery means duplicates are the healthy steady state; they are absorbed and
*counted*, because a redelivery that vanished from the numbers would be
indistinguishable from a bug.

**`sheets` (snapshot-diff CDC).** Apps Script triggers do not fire for API or
script writes and carry no delivery guarantee, so the push channel is modelled as
a latency hint only and reconcile against the sheet's own rows is the correctness
guarantee. Where a real-Google behavior was documented-but-unverified, the mock
encodes the **conservative** side (triggers coalesce under bulk edits, never
retry, and the trigger budget in the mock is a *lifetime* budget with no daily
rollover — strictly worse than reality). The connector therefore experiences a
worse channel than it would in production, and the drop-heavy oracle proves
convergence at 85% loss.

## Honest fidelity deltas

These are the places where the repo is *not* the vendor. They are stated here
rather than discovered at engagement time. The broader map is
[docs/real-connector-delta.md](../real-connector-delta.md).

1. **No real vendor authentication.** There is no OAuth 2.0 anywhere: no
   authorization-code flow, no refresh-token lifecycle, no token cache or expiry
   handling, no per-tenant app installation. Inbound push uses this repo's own
   per-source HMAC scheme (timestamped signature, ±300s window) — which is the
   *shape* every real vendor converges on, but not any vendor's actual header
   names or signing rules. Outbound pulls carry no credential at all. In a real
   integration this is the single largest connector-side cost: token lifecycle,
   re-auth on revocation, and the per-vendor signature scheme each land in the
   connector, not the spine.
2. **HTTP/JSON everywhere, including where the vendor's transport is not HTTP.**
   The most consequential case is the event-bus paradigm: Salesforce's Pub/Sub API
   is a **gRPC** service with Avro-encoded payloads and a bidirectional
   subscribe stream with flow control. `casebus` models it as an HTTP `/subscribe`
   endpoint returning JSON frames. What is preserved is the paradigm's semantics —
   subscription, opaque replay cursor, retention window, resettable stream,
   at-least-once delivery, one error code for two causes. What is *not* exercised
   is Avro schema evolution, gRPC keepalive/flow-control, or the client library's
   own replay handling. Similarly, `sheets` models the Sheets API surface as a
   single combined `GET /snapshot` rather than the real API's separate
   values/metadata calls and its quota model, and the trigger side is an HTTP POST
   rather than an Apps Script `UrlFetchApp` call from a script whose secret lives
   in editor-readable script properties.
3. **Two disclosed merge-modeling inferences.** The research tags them, and they
   are the only places where the mock's merge behavior goes beyond what a vendor
   page states:
   - **A merge event's `objectId` carries the survivor's id.** Not stated on any
     page read; the payload's documented fields are `primaryObjectId`,
     `mergedObjectIds` and `newObjectId`.
   - **404 on a consumed id.** The vendor documents that old ids are searchable
     via the *Merged IDs property* (reference data) and supported *only* on the
     basic update endpoint ("not supported … batch update"). Read-by-old-id is
     documented nowhere, so the mock refuses to invent an alias and answers 404.
     Re-tested against re-opened vendor pages on 2026-08-01 and left standing as
     the documented-behavior reading. Design corroboration only (digest-level,
     labeled as such): production ETL vendors handle HubSpot merges the same way —
     secondaries tracked as removed, lineage kept via `hs_merged_object_ids`, the
     survivor re-fetched after the merge.
4. **The chaos oracle is a mock affordance.** The zero-loss proof leans on a
   seq-ordered, tamper-evident, fully replayable ledger that doubles as a perfect
   enumeration of history. No real vendor hands you one. Against a real source the
   guarantee degrades from *provable zero loss* to *bounded staleness with
   detection* — the architecture is unchanged, the metric is renamed to what can
   actually be measured. Note also that reconcile proves **id-set parity, not
   payload parity**: a source that mutated an event's `data` and redelivered it
   under the same id reconciles clean.
5. **Sheets column reorder is unproven.** The mock models header *renames* only;
   column positions never move, so no test exercises a reorder. The connector is
   built for it by construction (positions resolved by header name on every fetch,
   never cached), but that expectation has never met a real spreadsheet. Verify
   before trusting it on a real engagement.
6. **Rate limits are modelled as injectable errors, not as budgets.** The mocks
   can return 429s on demand and the connectors back off; what is not modelled is
   a real quota *budget*, where a multi-year historical backfill has to be
   scheduled across days rather than retried through.

## Consequences

- Adding a fifth vendor means writing a connector against the existing seam
  (`catchUp` returning a typed report, `reconcile` returning a per-paradigm
  comparison) and declaring its loss boundary. Queueing, DLQs, quarantine,
  cursors, exactly-once storage, gap acknowledgement, and identity resolution are
  not touched. This was tested by doing it four times.
- The per-paradigm reconcile reports are deliberately *not* unified into one shape.
  A ledger feed can verify a hash chain; a feed, a bus and an object store cannot,
  and each CLI says exactly what it verified rather than printing a generic
  "integrity: ok". An earlier version did print a hash-chain line for a paradigm
  that has no chain; a cold review caught it, and the class — a surface claiming
  more than it checked — is now a standing review item.
- The delta list above is the engagement checklist, not a disclaimer. Item 1 alone
  is the bulk of the 6–9 week first-real-vendor estimate in
  [KNOWN-ISSUES](../../KNOWN-ISSUES.md).

## Alternatives rejected

- **One generic connector with per-vendor config.** Rejected: the four paradigms
  disagree about what "catch up" even means (re-read a grid, drain a cursor, fetch
  objects named by pushes, resume a subscription) and about whether loss is
  recoverable. A config-driven connector would have to model the union of those,
  and the honest per-paradigm loss reporting — the part that is actually worth
  something — would have been the first casualty.
- **Real vendor sandboxes instead of mocks.** Rejected: you cannot inject faults
  into a vendor's sandbox, sandbox data is too sparse to exercise integration
  edges, and none of it is publishable. The cost is exactly the delta list above,
  which is why the delta list is a document and not a footnote.
