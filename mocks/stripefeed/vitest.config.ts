import { defineConfig } from "vitest/config";
// ALLOW_DEV_SECRETS: tests are a dev context — this mock has no push surface (the feed
// is PULL-only), but the flag keeps the posture identical to the other mock workspaces.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], env: { ALLOW_DEV_SECRETS: "1" } },
});
