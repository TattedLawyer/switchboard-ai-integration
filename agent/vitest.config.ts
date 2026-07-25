import { defineConfig } from "vitest/config";
// 30s: these tests run live dbt-schema queries against Postgres; the vitest 5s
// default flakes under CI/shared-runner contention (see ingest/vitest.config.ts).
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 30_000 } });
