import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { createSourceApp } from "../src/source-app.js";
import { readLedger } from "../src/ledger.js";

let dir: string; let sink: Server; let sinkUrl: string;
let received: { body: unknown; sig: string | undefined }[];
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "core-"));
  received = [];
  const app = express(); app.use(express.json());
  app.post("/hook", (req, res) => {
    received.push({ body: req.body, sig: req.header("x-switchboard-signature") });
    res.sendStatus(200);
  });
  await new Promise<void>((r) => { sink = app.listen(0, () => r()); });
  sinkUrl = `http://127.0.0.1:${(sink.address() as { port: number }).port}/hook`;
});
afterEach(() => { sink.close(); rmSync(dir, { recursive: true, force: true }); });

describe("createSourceApp", () => {
  it("drives events from the script, ledgers first, and signs with the per-source secret", async () => {
    const app = createSourceApp({
      source: "billing", webhookUrl: sinkUrl, ledgerPath: join(dir, "l.jsonl"),
      script: (i) => ({ event_type: i % 2 === 0 ? "invoice.created" : "payment.succeeded", data: { id: `DEMO-I-${i}` } }),
    });
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    await fetch(`http://127.0.0.1:${port}/simulate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 4 }),
    });
    const ledger = readLedger(join(dir, "l.jsonl"));
    expect(ledger.map((e) => e.event_type)).toEqual([
      "invoice.created", "payment.succeeded", "invoice.created", "payment.succeeded",
    ]);
    expect(ledger.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(received).toHaveLength(4);
    const body0 = JSON.stringify(ledger[0]);
    const expected = `sha256=${createHmac("sha256", "demo-secret-billing").update(body0, "utf8").digest("hex")}`;
    expect(received[0].sig).toBe(expected);
    srv.close();
  });
});
