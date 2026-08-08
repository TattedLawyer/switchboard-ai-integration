import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { COL } from "../src/seed.js";
import { createSheetsApp, type SheetsApp } from "../src/server.js";
import { listenLoopback } from "@switchboard/mock-core";

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

async function boot(opts: Parameters<typeof createSheetsApp>[0]): Promise<{ url: string } & SheetsApp> {
  const built = createSheetsApp(opts);
  const srv = await listenLoopback(built.app);
  servers.push(srv);
  const { port } = srv.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, ...built };
}

describe("GET /values and /metadata", () => {
  it("/values returns the positional grid — header + rows, NO rowKeys anywhere", async () => {
    const { url, sheet } = await boot({ seed: 7, rowCount: 5 });
    const res = await fetch(`${url}/values`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(sheet.values());
    expect(JSON.stringify(body)).not.toContain("rk-");
  });

  it("/metadata returns the rowKey ↔ position mapping (the developer-metadata read)", async () => {
    const { url, sheet } = await boot({ seed: 7, rowCount: 4 });
    const res = await fetch(`${url}/metadata`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows: sheet.metadata() });
    expect(sheet.metadata().length).toBe(4);
  });

  it("/values reflects state mutations (the grid is live, not a boot snapshot)", async () => {
    const { url, sheet } = await boot({ seed: 7, rowCount: 3 });
    const key = sheet.metadata()[0].rowKey;
    sheet.apply({ type: "edit_cell", rowKey: key, column: COL.status, value: "won" });
    const body = await (await fetch(`${url}/values`)).json();
    expect(body.rows[0][COL.status]).toBe("won");
  });
});

describe("GET /snapshot (the combined atomic read — cold review I4)", () => {
  // Mirrors the real Sheets API capability: one spreadsheets.get call can return grid
  // data AND developer metadata together, i.e. from a single consistent state. The
  // split /values + /metadata pair stays for other consumers, but a diffing connector
  // must use THIS read: two reads of mutable state can pair rowKeys with wrong rows.
  it("returns header + rows + metadata from ONE consistent grid state", async () => {
    const { url, sheet } = await boot({ seed: 7, rowCount: 5 });
    const res = await fetch(`${url}/snapshot`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ...sheet.values(), metadata: sheet.metadata() });
    expect(body.metadata.length).toBe(body.rows.length);
  });

  it("stays internally consistent after mutations: every metadata entry addresses its own row's cells", async () => {
    const { url, sheet } = await boot({ seed: 7, rowCount: 4 });
    const key = sheet.metadata()[1].rowKey;
    sheet.apply({ type: "edit_cell", rowKey: key, column: COL.status, value: "won" });
    sheet.apply({ type: "insert_row_above", position: 0, cells: sheet.values().rows[0] });
    sheet.apply({ type: "delete_row", rowKey: sheet.metadata()[2].rowKey });

    const body = await (await fetch(`${url}/snapshot`)).json();
    expect(body.metadata.length).toBe(body.rows.length);
    for (const { rowKey, rowIndex } of body.metadata) {
      expect(body.rows[rowIndex]).toEqual(sheet.rowByKey(rowKey)!.cells);
    }
  });

  it("draws from the same seeded read-fault stream as the split reads (429 injection applies)", async () => {
    const { url } = await boot({ seed: 7, read429: { seed: 11, rate: 1 } });
    const res = await fetch(`${url}/snapshot`);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.status).toBe("RESOURCE_EXHAUSTED");
  });
});

describe("POST /simulate (the human path over HTTP)", () => {
  it("applies N editor steps under the named plan and journals them", async () => {
    const { url, sheet, editor } = await boot({ seed: 7 });
    const res = await fetch(`${url}/simulate?steps=5&plan=messy`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: 5, seq: 5 });
    expect(sheet.journal().length).toBe(5);
    expect(editor.steps()).toBe(5);
  });

  it("rejects an unknown plan and non-positive steps with 400", async () => {
    const { url } = await boot({ seed: 7 });
    expect((await fetch(`${url}/simulate?steps=3&plan=chaotic`, { method: "POST" })).status).toBe(400);
    expect((await fetch(`${url}/simulate?steps=0&plan=calm`, { method: "POST" })).status).toBe(400);
    expect((await fetch(`${url}/simulate?steps=x&plan=calm`, { method: "POST" })).status).toBe(400);
  });
});

describe("/status process honesty", () => {
  it("fresh at boot, stale after any step; seq advances with steps", async () => {
    const { url } = await boot({ seed: 7 });
    let status = await (await fetch(`${url}/status`)).json();
    expect(status.service).toBe("mock-sheets");
    expect(status.fresh).toBe(true);
    expect(status.seq).toBe(0);
    await fetch(`${url}/simulate?steps=3&plan=calm`, { method: "POST" });
    status = await (await fetch(`${url}/status`)).json();
    expect(status.fresh).toBe(false);
    expect(status.seq).toBe(3);
  });

  it("instance_id is stable within a boot and differs across boots", async () => {
    const a = await boot({ seed: 7 });
    const b = await boot({ seed: 7 });
    const idA1 = (await (await fetch(`${a.url}/status`)).json()).instance_id;
    const idA2 = (await (await fetch(`${a.url}/status`)).json()).instance_id;
    const idB = (await (await fetch(`${b.url}/status`)).json()).instance_id;
    expect(typeof idA1).toBe("string");
    expect(idA1).toBe(idA2);
    expect(idA1).not.toBe(idB);
  });
});

describe("429 injection (documented read-quota class; backoff is the connector's job)", () => {
  it("a seeded fraction of /values reads return 429 with the documented error body", async () => {
    const { url } = await boot({ seed: 7, read429: { seed: 11, rate: 0.25 } });
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) {
      const res = await fetch(`${url}/values`);
      statuses.push(res.status);
      if (res.status === 429) {
        const body = await res.json();
        expect(body.error.code).toBe(429);
        expect(body.error.status).toBe("RESOURCE_EXHAUSTED");
        expect(body.error.message).toMatch(/quota/i);
      } else {
        // non-faulted reads are completely unaffected
        expect((await res.json()).header.length).toBe(9);
      }
    }
    const faulted = statuses.filter((s) => s === 429).length;
    expect(faulted).toBeGreaterThan(0);
    expect(faulted).toBeLessThan(40);

    // seeded → the exact fault positions replay on an identical instance
    const twin = await boot({ seed: 7, read429: { seed: 11, rate: 0.25 } });
    const twinStatuses: number[] = [];
    for (let i = 0; i < 40; i++) twinStatuses.push((await fetch(`${twin.url}/values`)).status);
    expect(twinStatuses).toEqual(statuses);
  });

  it("no fault mode configured → reads never fault", async () => {
    const { url } = await boot({ seed: 7 });
    for (let i = 0; i < 20; i++) expect((await fetch(`${url}/values`)).status).toBe(200);
  });
});
