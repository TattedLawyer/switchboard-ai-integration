import { afterEach, describe, expect, it, vi } from "vitest";

// B1 (debt-burn): env parsing foot-guns. The service's boot config goes through bare
// `Number()` and an unchecked role string, so three misconfigurations become silent
// wrong behavior instead of a boot failure:
//   - PORT=banana        → Number() yields NaN, listen() misbehaves instead of refusing
//   - BACKFILL_INTERVAL_MS=soon → NaN, and Node's timers doc says verbatim: "When `delay`
//     is larger than 2147483647 or less than 1 or NaN, the delay will be set to 1" —
//     a typo'd interval becomes a documented ~1ms hot loop
//   - INGEST_ROLE=wroker → matches neither receiver nor worker nor all, so BOTH role
//     flags are false and the process boots and does NOTHING, silently
// These tests demand envalid-semantics (validate at boot, throw on invalid, error names
// the variable): importing the entrypoint module with a bad value must REJECT. The boot
// errors are operator surfaces — their wording is pinned in the unit block below.
//
// Import-level: main.ts parses its config at module top level, so a fresh import IS the
// boot-parse moment (the `import.meta.url` guard keeps main() itself from running — no
// ports bound, no pg-boss started).
async function importMainFresh(): Promise<unknown> {
  vi.resetModules();
  // Cache-busting via resetModules only; the specifier must stay identical so vitest
  // re-executes the same module graph under the stubbed env.
  return import("../src/main.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("B1: boot refuses invalid env instead of silently misbehaving", () => {
  it("PORT=banana → boot throws naming PORT (not NaN into listen())", async () => {
    vi.stubEnv("PORT", "banana");
    await expect(importMainFresh()).rejects.toThrow(/PORT/);
  });

  it("BACKFILL_INTERVAL_MS=soon → boot throws naming the var (not a documented ~1ms hot loop)", async () => {
    vi.stubEnv("BACKFILL_INTERVAL_MS", "soon");
    await expect(importMainFresh()).rejects.toThrow(/BACKFILL_INTERVAL_MS/);
  });

  it("INGEST_ROLE typo → boot throws listing the valid roles (not a process that does nothing)", async () => {
    vi.stubEnv("INGEST_ROLE", "wroker");
    await expect(importMainFresh()).rejects.toThrow(/receiver.*worker.*all/);
  });

  it("defaults still boot: no env overrides → import resolves", async () => {
    vi.stubEnv("PORT", "");
    vi.stubEnv("BACKFILL_INTERVAL_MS", "");
    vi.stubEnv("INGEST_ROLE", "");
    await expect(importMainFresh()).resolves.toBeDefined();
  });
});
