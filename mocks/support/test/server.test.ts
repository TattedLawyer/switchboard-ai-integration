import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { readLedger } from "@switchboard/mock-core";
import { createSupportApp } from "../src/server.js";

let dir: string;
let received: { body: { event_id: string }; sig: string | undefined }[];
let sink: Server;
let sinkUrl: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "support-test-"));
  received = [];
  const app = express();
  app.use(express.json());
  app.post("/hook", (req, res) => {
    received.push({ body: req.body, sig: req.header("x-switchboard-signature") });
    res.sendStatus(200);
  });
  await new Promise<void>((r) => { sink = app.listen(0, () => r()); });
  const addr = sink.address() as { port: number };
  sinkUrl = `http://127.0.0.1:${addr.port}/hook`;
});
afterEach(() => { sink.close(); rmSync(dir, { recursive: true, force: true }); });

describe("mock support", () => {
  it("simulate {count:8} → 8 ledger entries in the 4-slot cycle order, ticket.* embed requester fields + sla_due_at, all signatures verify", async () => {
    const ledgerPath = join(dir, "l.jsonl");
    const support = createSupportApp({ webhookUrl: sinkUrl, ledgerPath });
    const srv = support.listen(0);
    const port = (srv.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 8 }),
    });
    expect((await res.json()).emitted).toBe(8);

    const ledger = readLedger(ledgerPath);
    expect(ledger).toHaveLength(8);
    expect(ledger.map((e) => e.event_type)).toEqual([
      "ticket.created", "ticket.updated", "ticket.solved", "csat.recorded",
      "ticket.created", "ticket.updated", "ticket.solved", "csat.recorded",
    ]);

    // ticket.* events embed the requester denormalization + SLA field
    for (const e of ledger.filter((l) => l.event_type.startsWith("ticket."))) {
      const data = e.data as Record<string, unknown>;
      expect(String(data.requester_email)).toMatch(/@example\.com$/);
      expect(data.sla_due_at).toBeDefined();
    }

    // Every delivered signature verifies against the support demo secret
    expect(received).toHaveLength(8);
    for (const r of received) {
      const entry = ledger.find((e) => e.event_id === r.body.event_id);
      expect(entry).toBeDefined();
      const expected = `sha256=${createHmac("sha256", "demo-secret-support")
        .update(JSON.stringify(entry), "utf8").digest("hex")}`;
      expect(r.sig).toBe(expected);
    }
    srv.close();
  });

  it("faulted simulate: emitted + dropped === 20 and ledger still has all 20 (ledger never faulted)", async () => {
    const ledgerPath = join(dir, "l.jsonl");
    const support = createSupportApp({ webhookUrl: sinkUrl, ledgerPath });
    const srv = support.listen(0);
    const port = (srv.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        count: 20,
        fault_plan: { seed: 7, dropRate: 0.3, dupRate: 0, apiErrorRate: 0 },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.emitted + body.dropped).toBe(20);
    expect(readLedger(ledgerPath)).toHaveLength(20);
    srv.close();
  });
});
