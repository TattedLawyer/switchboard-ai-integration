import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendToLedger, readLedger, verifyLedgerChain } from "../src/ledger.js";

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
