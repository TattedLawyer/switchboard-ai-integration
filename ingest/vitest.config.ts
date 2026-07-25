import { defineConfig } from "vitest/config";
// 30s: nearly every test here provisions an ephemeral Postgres database; the vitest
// 5s default flakes under machine contention (observed during the 2026-07-25 external
// audit with parallel load, and CI shared runners are the same environment).
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 30_000 } });
