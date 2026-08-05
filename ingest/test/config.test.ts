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

  // PRE-3 / #21: INGEST_SOURCES was the one boot input outside this doctrine — it was
  // read INSIDE main(), tolerantly, so a typo could not be a boot refusal even in
  // principle. It now resolves at module top level like PORT/INGEST_ROLE, which is what
  // makes the refusal a BOOT refusal rather than a first-cycle surprise.
  it("INGEST_SOURCES typo → boot throws naming the bad token (not a silently smaller source set)", async () => {
    vi.stubEnv("INGEST_SOURCES", "hubcrm,stripfeed");
    await expect(importMainFresh()).rejects.toThrow(/INGEST_SOURCES.*stripfeed/s);
  });

  it("INGEST_SOURCES empty → boot throws (not a process that ingests nothing with every door still armed)", async () => {
    vi.stubEnv("INGEST_SOURCES", "");
    await expect(importMainFresh()).rejects.toThrow(/INGEST_SOURCES/);
  });

  it("defaults still boot: no env overrides → import resolves", async () => {
    vi.stubEnv("PORT", "");
    vi.stubEnv("BACKFILL_INTERVAL_MS", "");
    vi.stubEnv("INGEST_ROLE", "");
    await expect(importMainFresh()).resolves.toBeDefined();
  });
});

// PRE-3 / #20: `INGEST_ROLE=worker` refused to boot without WEBHOOK_SECRET_<SOURCE> for
// every enabled source — secrets a worker can never use. `secretForSource` is reached
// from exactly two places, both door handlers in server.ts (the event door and the
// sheets nudge door); no worker path consults it, so a worker loses nothing. The
// dangerous direction is the other one, and it is pinned here too: the RECEIVER must
// still fail closed.
describe("PRE-3 #20: door secrets are a receiver obligation, not a worker one", () => {
  const withNoSecrets = async (fn: () => void): Promise<string> => {
    vi.stubEnv("ALLOW_DEV_SECRETS", "");
    vi.stubEnv("WEBHOOK_SECRET_BILLING", "");
    vi.stubEnv("WEBHOOK_SECRET_SUPPORT", "");
    try {
      fn();
      return "";
    } catch (err) {
      return (err as Error).message;
    }
  };

  it("role=worker with no door secrets configured: no refusal", async () => {
    const { assertRoleSecrets } = await import("../src/main.js");
    expect(await withNoSecrets(() => assertRoleSecrets("worker", ["billing", "support"]))).toBe("");
  });

  it("role=receiver still fails closed, naming every missing variable", async () => {
    const { assertRoleSecrets } = await import("../src/main.js");
    const message = await withNoSecrets(() =>
      assertRoleSecrets("receiver", ["billing", "support"]),
    );
    expect(message).toContain("WEBHOOK_SECRET_BILLING");
    expect(message).toContain("WEBHOOK_SECRET_SUPPORT");
  });

  it("role=all still fails closed — the receiver half of `all` is a receiver", async () => {
    const { assertRoleSecrets } = await import("../src/main.js");
    expect(await withNoSecrets(() => assertRoleSecrets("all", ["billing"]))).toContain(
      "WEBHOOK_SECRET_BILLING",
    );
  });
});

// The boot errors are operator surfaces (operator-surface checklist): their exact
// wording is the pin, not just "some error mentioning the var".
describe("B1: parser semantics and pinned error wording (config.ts)", () => {
  it("intFromEnv: unset and empty both mean the default — empty is never parsed (Number('') is 0)", async () => {
    const { intFromEnv } = await import("../src/config.js");
    expect(intFromEnv("X", 42, { min: 1, max: 100 }, {})).toBe(42);
    expect(intFromEnv("X", 42, { min: 1, max: 100 }, { X: "" })).toBe(42);
  });

  it("intFromEnv: valid integer in range passes", async () => {
    const { intFromEnv } = await import("../src/config.js");
    expect(intFromEnv("X", 42, { min: 1, max: 100 }, { X: "7" })).toBe(7);
  });

  it("intFromEnv error wording: names the var, echoes the value, states the accepted range", async () => {
    const { intFromEnv } = await import("../src/config.js");
    expect(() => intFromEnv("PORT", 4002, { min: 1, max: 65535 }, { PORT: "banana" })).toThrow(
      'invalid PORT "banana": must be an integer between 1 and 65535',
    );
  });

  it("intFromEnv rejects non-integers and out-of-range values, not just NaN", async () => {
    const { intFromEnv } = await import("../src/config.js");
    const opts = { min: 1, max: 65535 };
    expect(() => intFromEnv("PORT", 4002, opts, { PORT: "80.5" })).toThrow(/invalid PORT/);
    expect(() => intFromEnv("PORT", 4002, opts, { PORT: "0" })).toThrow(/invalid PORT/);
    expect(() => intFromEnv("PORT", 4002, opts, { PORT: "70000" })).toThrow(/invalid PORT/);
  });

  it("choiceFromEnv error wording: names the var, echoes the value, lists every valid role", async () => {
    const { choiceFromEnv } = await import("../src/config.js");
    expect(() =>
      choiceFromEnv("INGEST_ROLE", "all", ["receiver", "worker", "all"], { INGEST_ROLE: "wroker" }),
    ).toThrow('invalid INGEST_ROLE "wroker": must be one of receiver, worker, all');
  });

  it("choiceFromEnv keeps the pre-B1 case tolerance: 'Receiver' is 'receiver'", async () => {
    const { choiceFromEnv } = await import("../src/config.js");
    expect(
      choiceFromEnv("INGEST_ROLE", "all", ["receiver", "worker", "all"], { INGEST_ROLE: "Receiver" }),
    ).toBe("receiver");
  });

  it("BACKFILL_INTERVAL_MS is bounded to setInterval's usable range (the NaN→1ms clamp boundary)", async () => {
    const { intFromEnv, MAX_TIMER_DELAY_MS } = await import("../src/config.js");
    expect(MAX_TIMER_DELAY_MS).toBe(2_147_483_647);
    const opts = { min: 1, max: MAX_TIMER_DELAY_MS };
    // one past the clamp boundary must refuse — Node would silently run it at 1ms
    expect(() => intFromEnv("BACKFILL_INTERVAL_MS", 60_000, opts, { BACKFILL_INTERVAL_MS: "2147483648" })).toThrow(
      /invalid BACKFILL_INTERVAL_MS/,
    );
    expect(intFromEnv("BACKFILL_INTERVAL_MS", 60_000, opts, { BACKFILL_INTERVAL_MS: "600000" })).toBe(600_000);
  });
});
