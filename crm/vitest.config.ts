import { defineConfig } from "vitest/config";
// Same rationale as approval/vitest.config.ts: most tests here provision an ephemeral
// Postgres database, and the vitest 5s default flakes under machine contention.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // TZ=UTC deliberately: the outreach window is Manila's, and a suite running in Manila
    // would pass a UTC-hardcoded gate by coincidence. T7's timezone pin needs the server
    // locale to DISAGREE with hers or it is testing nothing.
    env: { TZ: "UTC" },
  },
});
