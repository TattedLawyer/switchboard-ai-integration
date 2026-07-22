# Phase 0 journal — walking skeleton

**Planned:** 8 TDD tasks ending in a one-command end-to-end demo (`./scripts/demo.sh`):
one mock system → naive ingest → one dbt staging model → MCP server with one read
tool → host worker producing a stub Monday report → check script as exit criterion.

**What actually happened, beyond the plan:**

- **The build machine had no container runtime.** Docker Desktop had been uninstalled
  (dangling symlinks remained). Installed colima + docker CLI + compose plugin;
  first attempt hung on an unregistered compose plugin (`docker compose` not wired
  to the Homebrew standalone binary) — fixed via `cliPluginsExtraDirs` in
  `~/.docker/config.json`. Lesson: verify the toolchain exists before asserting it
  to implementers.
- **Dependency majors drifted from the plan.** Written against Express 4 / vitest 2;
  current majors are Express 5 / vitest 4. One workspace initially pinned Express 4
  while another used 5 — caught in review, unified on 5. Zero code adaptations were
  actually required by Express 5 for these code paths.
- **MCP SDK drift.** Plan targeted SDK ~1.17; installed 1.29. Two adaptations:
  `registerTool` inputSchema wrapped in `z.object()`, and undeclared-tool calls
  RESOLVE with `isError: true` + `MCP error -32602` text rather than throwing. The
  action-safety eval was strengthened to assert the specific rejection text after
  an empirical probe against the real server — a boolean `isError` check alone
  could pass vacuously.
- **Shared-database test fixtures bite.** The planned test fixture
  (`create or replace view` in the default analytics schema) silently clobbered the
  dbt-managed view. Fixed by isolating every DB-touching test suite in its own
  schema (env-var override + `drop schema ... cascade` teardown). Now a standing
  convention for all future test files.
- **Reliability findings in our own scripts.** Review caught an unbounded
  readiness-wait loop in demo.sh (hang risk) and an unhandled webhook-sink failure
  in the mock's `/simulate` (bare 500, no partial count). Both fixed test-first —
  the mock now returns 502 JSON with the delivered count, and the ledger-first
  invariant (append before delivery attempt) is what makes the delivery gap
  observable downstream, exactly the property Phase 1's reconciliation will use.

**Exit criterion met:** `./scripts/demo.sh` runs all six stages and passes the check
script; oracle verified (50 ledger lines = 50 raw rows); 16 tests green across
workspaces; typecheck clean.

**Deferred (triaged at final review):** dbt `tests:`→`data_tests:` key, distinct-on
tie-breaker, JSON error handler for ingest DB failures, package.json range bumps to
match resolved majors, report markdown code-fencing, pagination NaN guard.
