import { defineConfig } from "vitest/config";
// ALLOW_DEV_SECRETS: tests are a dev context — the fail-closed secret gate (A2) may
// serve its published demo defaults here. secrets.test.ts clears the flag per-test.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], env: { ALLOW_DEV_SECRETS: "1" } },
});
