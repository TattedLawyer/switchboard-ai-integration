import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { appendToLedger, readLedger, verifyLedgerChain, type LedgerEntry } from "../src/ledger.js";

let dir: string;
let ledgerPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-chain-"));
  ledgerPath = join(dir, "ledger.jsonl");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function appendN(n: number): void {
  for (let i = 1; i <= n; i++) {
    appendToLedger(ledgerPath, {
      event_id: `evt-${i}`,
      event_type: "company.updated",
      occurred_at: new Date().toISOString(),
      data: { id: `c-${i}`, name: `Company ${i}` },
      seq: i,
    });
  }
}

describe("ledger hash chain", () => {
  it("entries carry prev_hash and hash; genesis prev_hash is 64 zeros", () => {
    appendN(2);
    const entries = readLedger(ledgerPath);
    expect(entries).toHaveLength(2);
    expect(entries[0].prev_hash).toBe("0".repeat(64));
    expect(entries[0].hash).toMatch(/^[0-9a-f]{64}$/);
    // Each entry chains off the previous entry's hash
    expect(entries[1].prev_hash).toBe(entries[0].hash);
    expect(entries[1].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(entries[1].hash).not.toBe(entries[0].hash);
  });

  it("a fresh chain verifies ok:true", () => {
    appendN(5);
    expect(verifyLedgerChain(ledgerPath)).toEqual({ ok: true });
  });

  it("tampering with line 2 breaks the chain at line 2", () => {
    appendN(4);
    const lines = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
    const entry = JSON.parse(lines[1]);
    entry.data = { id: "c-2", name: "TAMPERED" }; // mutate payload, keep stored hash
    lines[1] = JSON.stringify(entry);
    writeFileSync(ledgerPath, lines.join("\n") + "\n", "utf8");

    expect(verifyLedgerChain(ledgerPath)).toEqual({ ok: false, brokenAt: 2 });
  });
});

// Reproduces, in test form, HMAC canonicalHash(prevHash, entry, key) from src/ledger.ts.
// A real forger has the source (it's not secret) but not LEDGER_HMAC_KEY, so this helper
// takes an arbitrary key — exactly what an attacker without the real key would run.
function forgeHash(prevHash: string, entry: LedgerEntry, key: string): string {
  const canonical = JSON.stringify({
    event_id: entry.event_id,
    event_type: entry.event_type,
    occurred_at: entry.occurred_at,
    data: entry.data,
    seq: entry.seq,
  });
  return createHmac("sha256", key).update(prevHash + canonical).digest("hex");
}

describe("ledger hash chain is keyed (HMAC), not just hashed", () => {
  // This is the property the un-keyed sha256(prev+canonical) chain could NOT provide:
  // before this fix, a forger who could write the ledger file (but never knew any
  // secret, because there wasn't one) could mutate an entry and correctly re-chain
  // every entry after it, and verifyLedgerChain would report ok:true. That forgery
  // is the auditor's finding. With an HMAC key, re-chaining requires the secret, so
  // a forger without it produces a chain that fails verification under the real key.
  const REAL_KEY = "real-secret-only-the-writer-and-auditor-hold";
  const WRONG_KEY = "attacker-guessed-key"; // forger does not know REAL_KEY

  it("detects a forger who mutates an entry and re-chains forward WITHOUT the real key", () => {
    // 1. Build a genuine chain of 4 entries with the real key.
    for (let i = 1; i <= 4; i++) {
      appendToLedger(
        ledgerPath,
        {
          event_id: `evt-${i}`,
          event_type: "company.updated",
          occurred_at: new Date(2026, 0, i).toISOString(),
          data: { id: `c-${i}`, name: `Company ${i}` },
          seq: i,
        },
        REAL_KEY,
      );
    }
    expect(verifyLedgerChain(ledgerPath, REAL_KEY)).toEqual({ ok: true });

    // 2. Forger mutates entry #2's data...
    const entries = readLedger(ledgerPath);
    entries[1] = { ...entries[1], data: { id: "c-2", name: "FORGED BY ATTACKER" } };

    // 3. ...then re-chains entries 2..n forward using a key the forger guessed, since
    // they don't know REAL_KEY. This is the exact attack the un-keyed chain couldn't
    // detect: recompute each subsequent hash so prev_hash/hash line up internally.
    entries[1].hash = forgeHash(entries[1].prev_hash, entries[1], WRONG_KEY);
    for (let i = 2; i < entries.length; i++) {
      entries[i] = { ...entries[i], prev_hash: entries[i - 1].hash };
      entries[i].hash = forgeHash(entries[i].prev_hash, entries[i], WRONG_KEY);
    }
    writeFileSync(ledgerPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    // 4. Internally the forged chain is self-consistent (prev_hash/hash all line up)
    // IF you don't know which key was supposed to be used — but the auditor verifies
    // with the REAL key, which the forger never had, so the forged hashes don't match.
    expect(verifyLedgerChain(ledgerPath, REAL_KEY)).toEqual({ ok: false, brokenAt: 2 });
  });
});
