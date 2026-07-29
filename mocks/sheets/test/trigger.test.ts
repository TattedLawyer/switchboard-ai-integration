import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { signBody } from "@switchboard/mock-core";
import { COL } from "../src/seed.js";
import { createSheetsApp, type SheetsAppOptions } from "../src/server.js";

let sink: Server;
let sinkUrl: string;
let received: { body: Record<string, unknown>; raw: string; sig: string | undefined }[];

beforeEach(async () => {
  received = [];
  const app = express();
  app.use(express.text({ type: "*/*" }));
  app.post("/hook", (req, res) => {
    received.push({
      body: JSON.parse(req.body as string),
      raw: req.body as string,
      sig: req.header("x-switchboard-signature"),
    });
    res.sendStatus(200);
  });
  await new Promise<void>((r) => { sink = app.listen(0, () => r()); });
  sinkUrl = `http://127.0.0.1:${(sink.address() as { port: number }).port}/hook`;
});
afterEach(() => sink.close());

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

async function boot(opts: SheetsAppOptions) {
  const built = createSheetsApp(opts);
  const srv = await new Promise<Server>((r) => { const s = built.app.listen(0, () => r(s)); });
  servers.push(srv);
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, ...built };
}

describe("thin signed notifications on the human path", () => {
  it("each human step posts ONE thin notification — sheet_id/range/occurred_at, never values — signed with the house HMAC", async () => {
    const { url, sheet } = await boot({
      seed: 7, webhookUrl: sinkUrl, trigger: { seed: 7, dropRate: 0, delayMs: 1 },
    });
    const res = await fetch(`${url}/simulate?steps=5&plan=calm`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(received.length).toBe(5);
    for (const n of received) {
      expect(Object.keys(n.body).sort()).toEqual(["occurred_at", "range", "sheet_id"]);
      expect(n.body.sheet_id).toBe(sheet.sheetId);
      // THIN: no cell content ever rides along (real path: onEdit → UrlFetchApp ping)
      expect(n.raw).not.toContain("@");
      expect(n.raw).not.toContain("DEMO");
      const t = Number(/^t=(\d+)/.exec(n.sig ?? "")?.[1]);
      expect(Number.isInteger(t)).toBe(true);
      expect(n.sig).toBe(signBody(n.raw, "demo-secret-sheets", t));
    }
    // delivery order preserved (delayMs is sequential, not a reorderer)
    const times = received.map((n) => Date.parse(String(n.body.occurred_at)));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("API-driven mutations NEVER fire the trigger (documented: script/API writes don't run triggers)", async () => {
    const { url, sheet } = await boot({
      seed: 7, webhookUrl: sinkUrl, trigger: { seed: 7, dropRate: 0 },
    });
    // direct state calls — the API path, not /simulate's human path
    const key = sheet.metadata()[0].rowKey;
    sheet.apply({ type: "edit_cell", rowKey: key, column: COL.status, value: "won" });
    sheet.apply({ type: "append_row", cells: sheet.values().rows[0].slice() });
    sheet.apply({ type: "delete_row", rowKey: key });
    await new Promise((r) => setTimeout(r, 50));
    expect(received.length).toBe(0);
    // and the human path still works afterwards
    await fetch(`${url}/simulate?steps=2&plan=calm`, { method: "POST" });
    expect(received.length).toBe(2);
  });
});

describe("lossiness knobs (all seed-deterministic)", () => {
  it("bulk coalescing: fewer notifications than rows changed (one per step, however wide)", async () => {
    const { url, sheet } = await boot({
      seed: 7, webhookUrl: sinkUrl, trigger: { seed: 7, dropRate: 0 },
    });
    await fetch(`${url}/simulate?steps=12&plan=bulk`, { method: "POST" });
    const rowsChanged = sheet.journal().reduce((n, j) => n + j.rowsChanged, 0);
    expect(received.length).toBe(12);
    expect(rowsChanged).toBeGreaterThan(received.length);
  });

  it("drops occur at the seeded rate, replay identically, and are never retried", async () => {
    const opts: SheetsAppOptions = {
      seed: 7, webhookUrl: sinkUrl, trigger: { seed: 13, dropRate: 0.5 },
    };
    const a = await boot(opts);
    await fetch(`${a.url}/simulate?steps=40&plan=calm`, { method: "POST" });
    const firstRun = received.map((n) => n.raw);
    expect(firstRun.length).toBeGreaterThan(6);
    expect(firstRun.length).toBeLessThan(34);

    received = [];
    const b = await boot(opts);
    await fetch(`${b.url}/simulate?steps=40&plan=calm`, { method: "POST" });
    expect(received.map((n) => n.raw)).toEqual(firstRun);
  });

  it("daily quota ceiling: posts silently stop after the budget — no error, no retry", async () => {
    const { url } = await boot({
      seed: 7, webhookUrl: sinkUrl, trigger: { seed: 7, dropRate: 0, dailyQuota: 5 },
    });
    const res = await fetch(`${url}/simulate?steps=20&plan=calm`, { method: "POST" });
    expect(res.status).toBe(200); // silence, not failure
    expect(received.length).toBe(5);
  });

  it("the notification stream is byte-identical across identical boots (determinism obligation)", async () => {
    const opts: SheetsAppOptions = {
      seed: 21, webhookUrl: sinkUrl, trigger: { seed: 21, dropRate: 0.2, dailyQuota: 30 },
    };
    const a = await boot(opts);
    await fetch(`${a.url}/simulate?steps=25&plan=hostile`, { method: "POST" });
    const first = received.map((n) => n.raw);
    expect(first.length).toBeGreaterThan(0); // guards against a vacuous []-equals-[] pass
    received = [];
    const b = await boot(opts);
    await fetch(`${b.url}/simulate?steps=25&plan=hostile`, { method: "POST" });
    expect(received.map((n) => n.raw)).toEqual(first);
  });

  it("a dead webhook is a counted failure, not a crash and not a retry", async () => {
    const deadUrl = "http://127.0.0.1:1/hook"; // nothing listens on port 1
    const { url, trigger } = await boot({
      seed: 7, webhookUrl: deadUrl, trigger: { seed: 7, dropRate: 0 },
    });
    const res = await fetch(`${url}/simulate?steps=3&plan=calm`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(trigger!.stats().failed).toBe(3);
    expect(trigger!.stats().posted).toBe(0);
  });
});
