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

// B3 (debt-burn): /simulate with an explicit start_index is a pure function of the
// request — which events a batch emits may not depend on how long the process has been
// alive. RFC 9110's idempotency property is the anchor: identical requests, identical
// effect, regardless of server history. Without it every /simulate answer is
// order-dependent and unreproducible after a crash/restart (the fresh_wait guards in
// demo.sh/chaos.sh detect the wrong-mix hazard loudly; this closes it at the source).
describe("createSourceApp /simulate start_index (B3)", () => {
  const script = (i: number) => ({
    event_type: i % 2 === 0 ? "invoice.created" : "payment.succeeded",
    data: { id: `DEMO-I-${i}` },
  });
  const emission = (path: string) =>
    readLedger(path).map((e) => ({
      seq: e.seq,
      event_id: e.event_id,
      event_type: e.event_type,
      data: e.data,
    }));

  // Sweep item 6 (naming honesty): what this proves is EVENT-IDENTITY purity —
  // seq/event_id/event_type/data are a function of the request alone. `occurred_at` is
  // wall-clock at emission time by design (so hashes differ too); the projection below
  // deliberately excludes it, and the old name ("emits identically") overclaimed.
  it("the same explicit-index request emits the same event identities (seq/event_id/type/data) across a server restart — occurred_at stays wall-clock", async () => {
    const request = {
      method: "POST" as const,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 3, start_index: 5 }),
    };
    // First server, some prior history so its process counter is NOT at 5.
    const appA = createSourceApp({
      source: "billing", webhookUrl: sinkUrl, ledgerPath: join(dir, "a.jsonl"), script,
    });
    const srvA = appA.listen(0);
    const portA = (srvA.address() as { port: number }).port;
    await fetch(`http://127.0.0.1:${portA}/simulate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 2 }),
    });
    await fetch(`http://127.0.0.1:${portA}/simulate`, request);
    srvA.close();

    // "Restart": a fresh process-lifetime counter, fresh ledger — the request is all
    // that carries the position.
    const appB = createSourceApp({
      source: "billing", webhookUrl: sinkUrl, ledgerPath: join(dir, "b.jsonl"), script,
    });
    const srvB = appB.listen(0);
    const portB = (srvB.address() as { port: number }).port;
    await fetch(`http://127.0.0.1:${portB}/simulate`, request);
    srvB.close();

    // Server A's explicit-index batch is its ledger tail (after the 2 counter events);
    // server B's is its whole ledger. Both must be the same three events: script
    // indices 5,6,7 — seq/event_id/type/data all a function of the request alone.
    const tailA = emission(join(dir, "a.jsonl")).slice(2);
    const allB = emission(join(dir, "b.jsonl"));
    expect(tailA).toEqual(allB);
    expect(allB.map((e) => e.seq)).toEqual([6, 7, 8]);
    expect(allB.map((e) => e.event_id)).toEqual(["evt-6", "evt-7", "evt-8"]);
    expect(allB.map((e) => e.data)).toEqual([
      { id: "DEMO-I-5" }, { id: "DEMO-I-6" }, { id: "DEMO-I-7" },
    ]);
  });

  it("default behavior is unchanged: no start_index → the process counter, exactly as before", async () => {
    const app = createSourceApp({
      source: "billing", webhookUrl: sinkUrl, ledgerPath: join(dir, "d.jsonl"), script,
    });
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    await fetch(`http://127.0.0.1:${port}/simulate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 2 }),
    });
    await fetch(`http://127.0.0.1:${port}/simulate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 2 }),
    });
    expect(emission(join(dir, "d.jsonl")).map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    srv.close();
  });

  it("after an explicit-index batch the counter continues from the batch end (monotonic, never rewinds)", async () => {
    const app = createSourceApp({
      source: "billing", webhookUrl: sinkUrl, ledgerPath: join(dir, "m.jsonl"), script,
    });
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    await fetch(`http://127.0.0.1:${port}/simulate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 2, start_index: 10 }),
    });
    const status = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
    expect(status.seq).toBe(12);
    // A later default batch continues past the explicit one — the shared ledger file
    // keeps strictly increasing seq (the chain verifier's predicate).
    await fetch(`http://127.0.0.1:${port}/simulate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 1 }),
    });
    expect(emission(join(dir, "m.jsonl")).map((e) => e.seq)).toEqual([11, 12, 13]);
    srv.close();
  });

  it("a start_index behind the counter never rewinds the counter for later default batches", async () => {
    const app = createSourceApp({
      source: "billing", webhookUrl: sinkUrl, ledgerPath: join(dir, "r.jsonl"), script,
    });
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    await fetch(`http://127.0.0.1:${port}/simulate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 5 }),
    });
    // Explicit low index: the request gets exactly what it asked for (a re-emission)…
    await fetch(`http://127.0.0.1:${port}/simulate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 1, start_index: 0 }),
    });
    // …but the process counter stays at its high-water mark: the next default batch
    // continues at 6, it does not re-walk 2..5.
    const status = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
    expect(status.seq).toBe(5);
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
