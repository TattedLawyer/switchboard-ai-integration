import { defineConfig } from "vitest/config";
// Same rationale as ingest/vitest.config.ts: every test here provisions an ephemeral
// Postgres database, and the vitest 5s default flakes under machine contention.
// ALLOW_DEV_SECRETS is NOT set globally — the proposal door's secret gate is the thing
// half these tests are about, so each suite opts in explicitly and the closed path stays
// reachable. (ingest sets it globally and pays for that with a per-test clear in
// secrets.test.ts; this workspace starts without the debt.)
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 120_000 },
});
