import { defineConfig } from "vitest/config";
// ALLOW_DEV_SECRETS: tests are a dev context. Like the stripefeed mock this paradigm has
// no push surface (a subscriber PULLS the stream), so the flag is posture parity with the
// other mock workspaces rather than load-bearing.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], env: { ALLOW_DEV_SECRETS: "1" } },
});
