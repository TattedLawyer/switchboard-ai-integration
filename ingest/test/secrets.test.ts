// Gate B claim pin for A2: secrets must FAIL CLOSED. Before this wave, every secret
// fell back to a constant published in this public repo (`demo-secret-<source>`,
// `demo-ledger-key`) — miss one env var in production and the only auth gate on the
// only write path validates against a string anyone can read on GitHub, and nothing
// refuses to boot (external audit 2026-07-25, R1; CWE-1188 insecure default,
// CWE-798 hard-coded credentials). The dev defaults survive, but only behind an
// explicit ALLOW_DEV_SECRETS=1 opt-in.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertWebhookSecrets, secretForSource } from "../src/hmac.js";
import { ledgerHmacKey } from "../src/reconcile.js";

const KEYS = [
  "WEBHOOK_SECRET_CRM",
  "WEBHOOK_SECRET_BILLING",
  "WEBHOOK_SECRET_SUPPORT",
  "LEDGER_HMAC_KEY",
  "ALLOW_DEV_SECRETS",
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("A2: webhook secrets fail closed", () => {
  it("no env, no opt-in: refuses with an error naming the variable and the opt-in", () => {
    expect(() => secretForSource("crm")).toThrow(/WEBHOOK_SECRET_CRM/);
    expect(() => secretForSource("crm")).toThrow(/ALLOW_DEV_SECRETS/);
  });

  it("ALLOW_DEV_SECRETS=1 restores the documented demo default", () => {
    process.env.ALLOW_DEV_SECRETS = "1";
    expect(secretForSource("crm")).toBe("demo-secret-crm");
  });

  it("a real secret needs no opt-in", () => {
    process.env.WEBHOOK_SECRET_CRM = "s3cret-from-vault";
    expect(secretForSource("crm")).toBe("s3cret-from-vault");
  });

  it("boot assertion aggregates ALL missing names into one error", () => {
    process.env.WEBHOOK_SECRET_CRM = "set";
    let message = "";
    try {
      assertWebhookSecrets(["crm", "billing", "support"]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("WEBHOOK_SECRET_BILLING");
    expect(message).toContain("WEBHOOK_SECRET_SUPPORT");
    expect(message).not.toContain("WEBHOOK_SECRET_CRM");
  });

  it("boot assertion passes silently when everything is set, or under the dev opt-in", () => {
    process.env.ALLOW_DEV_SECRETS = "1";
    expect(() => assertWebhookSecrets(["crm", "billing", "support"])).not.toThrow();
  });
});

describe("A2: ledger HMAC key fails closed (verifier side)", () => {
  it("refuses without env or opt-in; names both in the error", () => {
    expect(() => ledgerHmacKey()).toThrow(/LEDGER_HMAC_KEY/);
    expect(() => ledgerHmacKey()).toThrow(/ALLOW_DEV_SECRETS/);
  });

  it("opt-in restores the demo key; real env wins without opt-in", () => {
    process.env.ALLOW_DEV_SECRETS = "1";
    expect(ledgerHmacKey()).toBe("demo-ledger-key");
    delete process.env.ALLOW_DEV_SECRETS;
    process.env.LEDGER_HMAC_KEY = "vault-key";
    expect(ledgerHmacKey()).toBe("vault-key");
  });
});
