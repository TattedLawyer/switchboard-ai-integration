import { defineConfig } from "vitest/config";
// 30s: nearly every test here provisions an ephemeral Postgres database; the vitest
// 5s default flakes under machine contention (observed during the 2026-07-25 external
// audit with parallel load, and CI shared runners are the same environment).
// ALLOW_DEV_SECRETS: tests are a dev context — the fail-closed secret gate (A2) may
// serve its published demo defaults here. secrets.test.ts clears the flag per-test to
// prove the closed path.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: { ALLOW_DEV_SECRETS: "1" },
  },
});
