import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createHmac } from "node:crypto";
import { appendToLedger, readLedger, verifyLedgerChain, GENESIS_HASH, type LedgerEntry } from "../src/ledger.js";

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
function canonical(entry: LedgerEntry): string {
  return JSON.stringify({
    event_id: entry.event_id,
    event_type: entry.event_type,
    occurred_at: entry.occurred_at,
    data: entry.data,
    seq: entry.seq,
  });
}

function forgeHash(prevHash: string, entry: LedgerEntry, key: string): string {
  return createHmac("sha256", key).update(prevHash + canonical(entry)).digest("hex");
}

// The OLD, un-keyed scheme this fix replaced: plain sha256(prev + canonical), no
// secret involved. A forger reproduces it with only the (public) source.
function forgeHashSha256(prevHash: string, entry: LedgerEntry): string {
  return createHash("sha256").update(prevHash + canonical(entry)).digest("hex");
}

// A standalone re-implementation of the OLD un-keyed verifier, used only to prove
// (in this test) that the sha256-re-chained forgery below WOULD have verified ok:true
// under the pre-fix scheme — i.e. the fix, not a malformed forgery, is what catches it.
function verifyPlainSha256Chain(
  entries: LedgerEntry[],
): { ok: boolean; brokenAt?: number } {
  let expectedPrev = GENESIS_HASH;
  for (let i = 0; i < entries.length; i++) {
    const lineNo = i + 1;
    if (entries[i].prev_hash !== expectedPrev) return { ok: false, brokenAt: lineNo };
    if (forgeHashSha256(entries[i].prev_hash, entries[i]) !== entries[i].hash) {
      return { ok: false, brokenAt: lineNo };
    }
    expectedPrev = entries[i].hash;
  }
  return { ok: true };
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

  it("the forged chain is self-consistent under the attacker's OWN key, so rejection is the HMAC — not a malformed re-chain", () => {
    // Tautology guard for the test above: if the forged ledger were simply malformed
    // (broken prev_hash/hash linkage), verifyLedgerChain would reject it under ANY
    // key, and the ok:false result would prove nothing about the HMAC. Here the forger
    // rebuilds the ENTIRE ledger from genesis under their own (wrong) key, mutating
    // entry #2. That chain is fully self-consistent under the wrong key — proving the
    // re-chain is well-formed — yet the real key rejects it. So the rejection is
    // genuinely the secret, not a construction error.
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

    const entries = readLedger(ledgerPath);
    entries[1] = { ...entries[1], data: { id: "c-2", name: "FORGED BY ATTACKER" } };
    // Re-chain everything from genesis with the WRONG key (a full rewrite).
    let prev = GENESIS_HASH;
    for (let i = 0; i < entries.length; i++) {
      entries[i] = { ...entries[i], prev_hash: prev };
      entries[i].hash = forgeHash(prev, entries[i], WRONG_KEY);
      prev = entries[i].hash;
    }
    writeFileSync(ledgerPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

    // Well-formed under the attacker's own key...
    expect(verifyLedgerChain(ledgerPath, WRONG_KEY)).toEqual({ ok: true });
    // ...but rejected under the real key — and it fails at the very first entry, since
    // even the genesis link now carries a wrong-key HMAC the auditor can't reproduce.
    expect(verifyLedgerChain(ledgerPath, REAL_KEY)).toEqual({ ok: false, brokenAt: 1 });
  });

  it("a forgery re-chained under the OLD un-keyed sha256 scheme succeeds there but fails under the real HMAC key", () => {
    // Makes the phase1 journal claim literally true: the same mutate-and-re-chain
    // forgery that WOULD have succeeded against the old sha256(prev+canonical) chain is
    // caught by the keyed chain. A forger has only the (public) source, no secret.
    const genuine: LedgerEntry[] = [];
    for (let i = 1; i <= 4; i++) {
      const input: LedgerEntry = {
        event_id: `evt-${i}`,
        event_type: "company.updated",
        occurred_at: new Date(2026, 0, i).toISOString(),
        data: { id: `c-${i}`, name: `Company ${i}` },
        seq: i,
        prev_hash: "",
        hash: "",
      };
      genuine.push(input);
    }

    // (a) OLD-SCHEME WORLD: an entire ledger built with un-keyed sha256 (the pre-fix
    // writer). The forger mutates entry #2 and re-chains 2..n with sha256 — and the old
    // verifier reports ok:true. This is exactly the auditor's demonstrated attack.
    const oldChain = genuine.map((e) => ({ ...e }));
    let prev = GENESIS_HASH;
    for (let i = 0; i < oldChain.length; i++) {
      oldChain[i].prev_hash = prev;
      oldChain[i].hash = forgeHashSha256(prev, oldChain[i]);
      prev = oldChain[i].hash;
    }
    oldChain[1] = { ...oldChain[1], data: { id: "c-2", name: "FORGED, OLD SCHEME" } };
    oldChain[1].hash = forgeHashSha256(oldChain[1].prev_hash, oldChain[1]);
    for (let i = 2; i < oldChain.length; i++) {
      oldChain[i] = { ...oldChain[i], prev_hash: oldChain[i - 1].hash };
      oldChain[i].hash = forgeHashSha256(oldChain[i].prev_hash, oldChain[i]);
    }
    expect(verifyPlainSha256Chain(oldChain)).toEqual({ ok: true });

    // (b) NEW-SCHEME WORLD: a genuine keyed ledger. The forger, holding only the public
    // source and no secret, does the best they can — re-chains the mutated tail with
    // plain sha256. Under the real key the keyed verifier catches it at the mutated entry.
    for (let i = 1; i <= 4; i++) {
      appendToLedger(ledgerPath, genuine[i - 1], REAL_KEY);
    }
    const keyed = readLedger(ledgerPath);
    keyed[1] = { ...keyed[1], data: { id: "c-2", name: "FORGED, OLD SCHEME" } };
    keyed[1].hash = forgeHashSha256(keyed[1].prev_hash, keyed[1]);
    for (let i = 2; i < keyed.length; i++) {
      keyed[i] = { ...keyed[i], prev_hash: keyed[i - 1].hash };
      keyed[i].hash = forgeHashSha256(keyed[i].prev_hash, keyed[i]);
    }
    writeFileSync(ledgerPath, keyed.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
    expect(verifyLedgerChain(ledgerPath, REAL_KEY)).toEqual({ ok: false, brokenAt: 2 });
  });
});
