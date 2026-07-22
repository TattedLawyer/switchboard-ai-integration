# Design note: deletion and erasure in an append-only pipeline

**Status: design, not implementation.** Switchboard runs exclusively on synthetic
data (enforced by automated fixture-hygiene tests — `@example.com` emails, `DEMO-`
prefixes, no realistic identifiers), so no erasure obligation can attach to this
repository. This note exists because any real deployment of this architecture meets
data-subject deletion requests (GDPR right to erasure, CCPA deletion) on day one,
and an append-only, hash-chained event pipeline looks — at first glance — like it
was built to make erasure impossible. It wasn't, and event-sourced systems actually
make erasure *more* tractable than mutable databases, if designed for it.

## The three mechanisms

**1. Tombstone events.** A deletion request enters the pipeline as a first-class
event (`company.erased`, carrying only the entity id), flowing through the same
idempotent, ledgered, reconciled path as every other event. Downstream models treat
a tombstone as terminal: the entity disappears from `stg_*` views and marts on the
next build. This gives erasure the same auditability and zero-loss guarantees as
ordinary data.

**2. Raw-store redaction with structural preservation.** The raw event rows for an
erased entity are rewritten to strip payload contents while preserving row identity
(event_id, event_type, timestamps) — so counts, reconciliation, and referential
history survive, but personal data does not. This is the one place append-only is
deliberately broken, by a privileged, logged erasure job — not by application code.

**3. Hash-chain compatibility via crypto-shredding or hash-only entries.** A naive
redaction breaks the ledger's tamper-evident chain (HMAC-keyed via `LEDGER_HMAC_KEY`,
so tamper-evidence holds against anyone without that key — not a plain hash chain).
Two standard resolutions:
- *Crypto-shredding:* payloads in durable logs are encrypted per-entity; erasure
  destroys the entity's key, rendering its ledger entries permanently unreadable
  while leaving the chain bytes — and therefore chain verification — intact.
- *Hash-only entries:* the ledger stores payload digests rather than payloads
  (contents live in the redactable raw store), so the chain never contains personal
  data in the first place. Chain verification is unaffected by erasure.

The current demo ledger stores full payloads (fine for synthetic data); a real
deployment picks one of the two above, decided in discovery.

## The sweep and its proof

Erasure completes with a sweep job that walks every derived artifact (raw, marts,
generated reports, quarantine, DLQ payloads) for the entity id and verifies
absence — the same reconciliation discipline used for zero-loss, pointed at
zero-presence. The sweep's output is the auditable evidence a controller needs for
a DSR response, with a deadline well inside the applicable statutory window
(verified per jurisdiction at engagement time rather than asserted here).

## Why this section exists in a portfolio project

Because "how does a deletion request propagate?" is a question this architecture
must answer before any business deploys it, and the honest answer — designed,
not yet implemented, structurally compatible — is documented rather than
discovered in a meeting.
