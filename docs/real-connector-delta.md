# Real-connector delta: what changes against actual vendors

Switchboard's mock CRM was designed so the reliability machinery is publishable and
chaos-testable — you cannot inject faults into a vendor's production sandbox. This
document is the honest map from the mock to real systems, layer by layer. Where it
names vendor-specific mechanics it describes typical shapes; exact API details are
verified against current vendor docs at engagement time, not assumed.

## The headline honesty item: "zero lost events" changes meaning

Our chaos proof relies on a mock affordance real CRMs don't offer: a seq-ordered,
replayable event feed (`GET /events?after=<seq>`) that doubles as a perfect oracle.
Real webhook-style vendors typically offer eventually-consistent
"modified-since" search endpoints with pagination limits, and no guarantee you can
enumerate every historical change.

Against a real source, the guarantee therefore degrades from **provable zero loss**
to **bounded staleness with detection**: the push path stays best-effort, the poll
path becomes modified-since sweeps on a cursor, and a periodic full reconciliation
sweep against the vendor's list endpoints measures *detection latency* instead of
proving equality against an oracle. The architecture is unchanged; the metric is
renamed to what can actually be measured. That reframing is a feature of this
project, not a concession discovered later.

## Layer 1 (ingestion) — where almost all the delta lives

| Mock today | Real engagement |
|---|---|
| Shared-secret HMAC header (built in Phase 1) | Vendor-specific signature schemes and header names; same verify-before-accept pattern |
| No auth on outbound polls | OAuth 2.0 with refresh-token lifecycle; token cache until expiry |
| Seq-cursor event feed | Modified-since search + opaque vendor cursors; per-object-type sweeps |
| Injected 429s, retry with backoff | Real rate-limit *budgets*: a multi-year historical backfill must be scheduled across days within quota, not retried through |
| One event shape | Per-vendor payload discovery, custom fields/properties, API versioning |
| Drop/duplicate/out-of-order faults on demand | The same failures, on the vendor's schedule, unannounced |

Also new against real systems: webhook endpoint registration/verification
handshakes, delivery-retry semantics that differ per vendor, and sandbox
environments whose data is too sparse to test integration edge cases (one reason
the synthetic harness remains useful even mid-engagement).

## The event-bus paradigm (enterprise sources)

Some enterprise platforms don't push webhooks at all. Salesforce delivers change
events through a subscribe model — Platform Events and Change Data Capture over the
gRPC-based Pub/Sub API — rather than HTTP callbacks
([Salesforce Pub/Sub API docs](https://developer.salesforce.com/docs/platform/pub-sub-api/guide/intro.html),
[Hookdeck's overview of Salesforce's non-webhook model](https://hookdeck.com/webhooks/platforms/guide-to-salesforce-webhooks-features-and-best-practices)).
A connector for that world holds a subscription with a replay cursor instead of
exposing an endpoint. Layer 1 already models both halves of that idea (push
receiver + cursored puller); a planned Phase 2+ mock adds an event-bus-shaped
source so both integration paradigms are demonstrated.

## Layers 2–3 — mostly unchanged

The raw `jsonb` event store absorbs vendor schema differences by design; dbt
remapping is where vendor-specific field names get normalized. Identity resolution
gains vendor merge events (real CRMs merge duplicate records and emit merge
notifications that must collapse identities downstream). The MCP/agent layer is
vendor-agnostic — it reads the unified model and never touches vendor APIs.

## Operational deltas

Secrets management (per-vendor credentials, rotation), per-source monitoring of
webhook delivery health and poll-lag, and vendor-status-page awareness in runbooks.
See RUNBOOK.md for the current single-source version of these procedures.
