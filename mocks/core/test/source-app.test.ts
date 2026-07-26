import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import { createSourceApp } from "../src/source-app.js";
import { signBody } from "../src/hmac.js";
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
    // A3: the header carries its own signed timestamp — recompute for the delivered t.
    const t0 = Number(/^t=(\d+)/.exec(received[0].sig ?? "")?.[1]);
    expect(Number.isInteger(t0)).toBe(true);
    expect(received[0].sig).toBe(signBody(body0, "demo-secret-billing", t0));
    srv.close();
  });
});

// GET /status exposes the script cursor so callers can prove a mock is FRESH before driving it.
// Motivation (CI 30159422468): scripts/demo.sh's readiness probe only checked that *something*
// answered on the port. A leftover server from a prior script — npm run does not reap its
// grandchild on SIGTERM (npm/cli#6684) — was therefore indistinguishable from a fresh one, and
// silently served the demo with its script cursor already past the merge slots at index 45/46.
// The result was a passing drain gate and eight downstream identity failures. Liveness is not
// readiness: the probe has to assert STATE, not just that the socket is open.
describe("createSourceApp /status", () => {
  it("reports seq=0 on a fresh app and the advanced cursor after simulate", async () => {
    const app = createSourceApp({
      source: "billing", webhookUrl: sinkUrl, ledgerPath: join(dir, "s.jsonl"),
      script: (i) => ({ event_type: "invoice.created", data: { id: `DEMO-I-${i}` } }),
    });
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;

    const fresh = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
    expect(fresh).toEqual({ source: "billing", seq: 0, fresh: true });

    await fetch(`http://127.0.0.1:${port}/simulate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 3 }),
    });

    const used = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
    expect(used).toEqual({ source: "billing", seq: 3, fresh: false });
    srv.close();
  });
});
