import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import { createCrmApp } from "../src/server.js";
import { createFaultInjector } from "../src/faults.js";
import { readLedger } from "../src/ledger.js";

let dir: string;
let received: unknown[];
let sink: Server;
let sinkUrl: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "crm-test-"));
  received = [];
  const app = express();
  app.use(express.json());
  app.post("/hook", (req, res) => { received.push(req.body); res.sendStatus(200); });
  await new Promise<void>((r) => { sink = app.listen(0, () => r()); });
  const addr = sink.address() as { port: number };
  sinkUrl = `http://127.0.0.1:${addr.port}/hook`;
});
afterEach(() => { sink.close(); rmSync(dir, { recursive: true, force: true }); });

describe("fault injector", () => {
  it("is deterministic for the same seed", () => {
    const a = createFaultInjector({ seed: 7, dropRate: 0.3, dupRate: 0.2, apiErrorRate: 0.5 });
    const b = createFaultInjector({ seed: 7, dropRate: 0.3, dupRate: 0.2, apiErrorRate: 0.5 });
    const fatesA = Array.from({ length: 50 }, () => a.deliveryFate());
    const fatesB = Array.from({ length: 50 }, () => b.deliveryFate());
    expect(fatesA).toEqual(fatesB);
    expect(new Set(fatesA)).toEqual(new Set(["deliver", "drop", "duplicate"]));
  });

  it("without a plan never faults", () => {
    const inj = createFaultInjector();
    expect(Array.from({ length: 20 }, () => inj.deliveryFate()).every((f) => f === "deliver")).toBe(true);
    expect(inj.apiShouldFail()).toBe(false);
  });

  it("simulate with fault_plan injects drops, duplicates, and maintains ledger completeness", async () => {
    const ledgerPath = join(dir, "l.jsonl");
    const crm = createCrmApp({ webhookUrl: sinkUrl, ledgerPath });
    const srv = crm.listen(0);
    const port = (srv.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        count: 40,
        fault_plan: { seed: 7, dropRate: 0.25, dupRate: 0.25, apiErrorRate: 0 },
      }),
    });

    const body = await res.json();
    const ledger = readLedger(ledgerPath);

    // Ledger has exactly 40 entries (all events, regardless of fate)
    expect(ledger).toHaveLength(40);

    // Response has the expected structure
    expect(body).toHaveProperty("emitted");
    expect(body).toHaveProperty("dropped");
    expect(body).toHaveProperty("duplicated");

    // Accounting: emitted + dropped = count
    expect(body.emitted + body.dropped).toBe(40);

    // Dropped > 0 (because dropRate = 0.25)
    expect(body.dropped).toBeGreaterThan(0);

    // Received webhooks: each delivered event sends once, each duplicated event sends twice
    // So: received.length = body.emitted + body.duplicated
    expect(received).toHaveLength(body.emitted + body.duplicated);

    // All received event_ids must be in the ledger
    const ledgerEventIds = new Set(ledger.map((e) => e.event_id));
    const receivedEventIds = (received as { event_id: string }[]).map((e) => e.event_id);
    for (const eventId of receivedEventIds) {
      expect(ledgerEventIds.has(eventId)).toBe(true);
    }

    srv.close();
  });

  it("plan-less simulate resets fault injector (GET /events must 200, not 429)", async () => {
    const ledgerPath = join(dir, "l.jsonl");
    const crm = createCrmApp({ webhookUrl: sinkUrl, ledgerPath });
    const srv = crm.listen(0);
    const port = (srv.address() as { port: number }).port;

    // First: simulate WITH a fault plan that guarantees 429s
    const res1 = await fetch(`http://127.0.0.1:${port}/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        count: 5,
        fault_plan: { seed: 1, dropRate: 0, dupRate: 0, apiErrorRate: 1 },
      }),
    });
    expect(res1.ok).toBe(true);

    // Now try to GET /events — should 429 because server-level injector has the fault plan
    const getRes1 = await fetch(`http://127.0.0.1:${port}/events`);
    expect(getRes1.status).toBe(429);

    // Second: simulate WITHOUT fault_plan — should reset the server-level injector
    const res2 = await fetch(`http://127.0.0.1:${port}/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 5 }),
    });
    expect(res2.ok).toBe(true);

    // Now GET /events should return 200 (injector reset, no faults)
    const getRes2 = await fetch(`http://127.0.0.1:${port}/events`);
    expect(getRes2.status).toBe(200);

    srv.close();
  });
});
