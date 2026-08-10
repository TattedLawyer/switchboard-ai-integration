import { defineConfig } from "vitest/config";
// Same rationale as approval/vitest.config.ts: most tests here provision an ephemeral
// Postgres database, and the vitest 5s default flakes under machine contention.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 120_000 },
});
