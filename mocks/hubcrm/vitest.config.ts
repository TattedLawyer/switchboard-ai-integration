import { defineConfig } from "vitest/config";
// ALLOW_DEV_SECRETS: tests are a dev context — this mock SIGNS its webhook batches with
// the house per-source secret (the first faithful PUSH source of 2b), so the flag is
// load-bearing here, not just posture.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], env: { ALLOW_DEV_SECRETS: "1" } },
});
