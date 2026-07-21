# Phase 1 journal — reliability spine

**Planned:** fault injection, idempotent ingest with transactional outbox, pg-boss
push pipeline with DLQ + replay, cursor backfill, quarantine, and a chaos
reconciliation test proving zero lost events — plus a mid-phase amendment (adopted
after a deployment-readiness review): webhook HMAC, out-of-order faults with
event-time ordering, an LLM operational envelope, and a hash-chained ledger.

**The result:** `./scripts/chaos.sh` — 200 events under seeded faults (20% dropped
webhooks, 15% duplicate deliveries, 20% API errors, shuffled delivery order):
165 arrive via the push path, the cursor backfill recovers exactly the 35 dropped,
reconciliation verifies the ledger hash chain then proves set equality with zero
duplicates, quarantine and DLQ both empty, in ~20 seconds, deterministically
(same seed → same counts, run twice). The detector's teeth are proven by a RED mode
(`CHAOS_SKIP_BACKFILL=1`) that must fail with exactly the dropped events listed.

**What actually happened, beyond the plan:**

- **Review caught an unproven safety claim.** The pg-boss task shipped "green" with
  a poison test that only proved *absence* (event not ingested) — not *presence*
  (job in the DLQ). Fixing it surfaced two real bugs: the DLQ peek filter excluded
  the state dead-lettered jobs actually land in, and queue creation was idempotent
  so injected test retry-options silently no-opped (fixed with an explicit
  upsert). Lesson now codified as a project gate: every safety property needs a
  test that fails when the property breaks.
- **A verification panel caught the demo lying.** After ingestion went async, the
  demo declared success having processed 5 of 50 events — its checker couldn't
  tell. The fix strengthened the checker into an oracle-equality gate
  (ledger = raw = outbox) and added a drain-wait that requires true queue
  quiescence, not just a count plateau.
- **Live probing found what unit tests didn't:** an invalid request to the mock
  leaked a stack trace with filesystem paths (500 HTML); junk pagination params
  returned `page: null`. Both hardened, test-first.
- **Empirical API archaeology:** pg-boss v12's `complete()` only transitions
  active-state jobs, so the replay CLI consumes DLQ entries via `deleteJob` —
  discovered by reading the library's own plans, verified against the live
  database. The MCP-style "adaptation zone" briefing pattern (behavioral contract
  fixed, API shape discovered at install time) held up for a second dependency.
- **The reviewers were audited too.** One review applied Express 4 async-error
  semantics to this Express 5 codebase; the finding was overruled with repo facts.
  Review is a signal, not an authority.
- **The mid-phase deployment-readiness review reshaped the phase.** A
  skeptical-CTO pass produced 13 findings; the cheap-four (HMAC, out-of-order
  ordering, LLM envelope, hash chain) were folded in as a hardening task, README
  overclaims were corrected same-day, and the paper answers (real-connector delta,
  GDPR erasure design, scaling ceilings, runbook) became this docs set.

**Deferred, tracked for the whole-branch triage:** shared JSON-error middleware for
ingest DB-failure paths; schema dedup between server/quarantine validators; replay
depth flag (`--all`); backfill backoff constants; dbt tie-break follow-ups; assorted
polish recorded in the review ledger.
