// A2 mirror for the mock-side copies (see ingest/test/secrets.test.ts for the rationale
// and audit provenance): the writer side must fail closed exactly like the verifier side,
// or a prod mock/ledger writer silently signs with published constants.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secretForSource } from "../src/hmac.js";
import { appendToLedger, ledgerHmacKey } from "../src/ledger.js";

const KEYS = ["WEBHOOK_SECRET_CRM", "LEDGER_HMAC_KEY", "ALLOW_DEV_SECRETS"];
let saved: Record<string, string | undefined>;
let dir: string;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "secrets-test-"));
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("A2 (mock side): secrets fail closed", () => {
  it("secretForSource refuses without env or ALLOW_DEV_SECRETS=1", () => {
    expect(() => secretForSource("crm")).toThrow(/WEBHOOK_SECRET_CRM/);
    process.env.ALLOW_DEV_SECRETS = "1";
    expect(secretForSource("crm")).toBe("demo-secret-crm");
  });

  it("ledgerHmacKey refuses without env or opt-in", () => {
    expect(() => ledgerHmacKey()).toThrow(/LEDGER_HMAC_KEY/);
    expect(() => ledgerHmacKey()).toThrow(/ALLOW_DEV_SECRETS/);
  });

  it("appendToLedger's default key path fails closed — a writer cannot silently chain on the published key", () => {
    const entry = { event_id: "evt-1", event_type: "t", occurred_at: "2026-07-25T00:00:00.000Z", data: {}, seq: 1 };
    expect(() => appendToLedger(join(dir, "ledger.jsonl"), entry)).toThrow(/LEDGER_HMAC_KEY/);
    process.env.ALLOW_DEV_SECRETS = "1";
    expect(() => appendToLedger(join(dir, "ledger.jsonl"), entry)).not.toThrow();
  });
});
