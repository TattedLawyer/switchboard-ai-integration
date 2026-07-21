import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import { createCrmApp } from "../src/server.js";

let dir: string; let sink: Server; let sinkUrl: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "crm-feed-"));
  const app = express(); app.use(express.json());
  app.post("/hook", (_req, res) => res.sendStatus(200));
  await new Promise<void>((r) => { sink = app.listen(0, () => r()); });
  sinkUrl = `http://127.0.0.1:${(sink.address() as { port: number }).port}/hook`;
});
afterEach(() => { sink.close(); rmSync(dir, { recursive: true, force: true }); });

describe("GET /events", () => {
  it("pages ledgered events by seq cursor", async () => {
    const crm = createCrmApp({ webhookUrl: sinkUrl, ledgerPath: join(dir, "l.jsonl") });
    const srv = crm.listen(0);
    const port = (srv.address() as { port: number }).port;
    await fetch(`http://127.0.0.1:${port}/simulate`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ count: 12 }) });
    const p1 = await (await fetch(`http://127.0.0.1:${port}/events?after=0&limit=5`)).json();
    expect(p1.events).toHaveLength(5);
    expect(p1.events[0].seq).toBe(1);
    expect(p1.last_seq).toBe(5);
    const p2 = await (await fetch(`http://127.0.0.1:${port}/events?after=${p1.last_seq}&limit=50`)).json();
    expect(p2.events).toHaveLength(7);
    expect(p2.events.map((e: { seq: number }) => e.seq)).toEqual([6,7,8,9,10,11,12]);
    expect(p2.last_seq).toBe(12);
    const p3 = await (await fetch(`http://127.0.0.1:${port}/events?after=12`)).json();
    expect(p3.events).toHaveLength(0);
    expect(p3.last_seq).toBe(12);
    srv.close();
  });
});
