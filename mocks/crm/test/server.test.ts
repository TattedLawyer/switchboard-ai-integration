import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import { createCrmApp } from "../src/server.js";
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

describe("mock CRM", () => {
  it("paginates companies", async () => {
    const crm = createCrmApp({ webhookUrl: sinkUrl, ledgerPath: join(dir, "l.jsonl") });
    const srv = crm.listen(0);
    const port = (srv.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/companies?page=2&per_page=8`);
    const body = await res.json();
    expect(body.total).toBe(20);
    expect(body.items).toHaveLength(8);
    expect(body.items[0].id).toBe("DEMO-C-0009");
    srv.close();
  });

  it("simulate emits webhooks AND ledgers every event first", async () => {
    const ledgerPath = join(dir, "l.jsonl");
    const crm = createCrmApp({ webhookUrl: sinkUrl, ledgerPath });
    const srv = crm.listen(0);
    const port = (srv.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 10 }),
    });
    expect((await res.json()).emitted).toBe(10);
    const ledger = readLedger(ledgerPath);
    expect(ledger).toHaveLength(10);
    expect(received).toHaveLength(10);
    expect(ledger.map((e) => e.event_id)).toEqual(
      (received as { event_id: string }[]).map((e) => e.event_id),
    );
    srv.close();
  });

  it("simulate returns 502 with partial count when webhook delivery fails", async () => {
    // Create a dead port: spin up a sink, note its port, then close it
    const deadApp = express();
    await new Promise<void>((r) => { sink = deadApp.listen(0, () => r()); });
    const deadAddr = sink.address() as { port: number };
    const deadUrl = `http://127.0.0.1:${deadAddr.port}/hook`;
    sink.close(); // close immediately so the port is unreachable

    const ledgerPath = join(dir, "l.jsonl");
    const crm = createCrmApp({ webhookUrl: deadUrl, ledgerPath });
    const srv = crm.listen(0);
    const port = (srv.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 5 }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ error: "webhook delivery failed", emitted: 0, dropped: 0, duplicated: 0 });

    // Ledger should have at least 1 entry (the first one that was appended before delivery failed)
    const ledger = readLedger(ledgerPath);
    expect(ledger.length).toBeGreaterThanOrEqual(1);

    srv.close();
  });

  it("simulate covers all company ids (seed coverage)", async () => {
    const ledgerPath = join(dir, "l.jsonl");
    const crm = createCrmApp({ webhookUrl: sinkUrl, ledgerPath });
    const srv = crm.listen(0);
    const port = (srv.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 80 }),
    });
    expect((await res.json()).emitted).toBe(80);

    const ledger = readLedger(ledgerPath);
    const companyEvents = ledger.filter((e) => e.event_type === "company.updated");
    const distinctCompanyIds = new Set(companyEvents.map((e) => (e.data as { id: string }).id));

    expect(distinctCompanyIds.size).toBe(20);
    srv.close();
  });
});
