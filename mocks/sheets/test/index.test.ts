import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

// The exported surface IS the connector's (A4) compile-time interface to this mock.
// This pin keeps index.ts honest: everything the brief promises is actually exported.
describe("package export surface for the connector slice", () => {
  it("exports the grid, editor, server, and trigger construction functions", () => {
    expect(typeof api.createSheet).toBe("function");
    expect(typeof api.createRowSource).toBe("function");
    expect(typeof api.createEditor).toBe("function");
    expect(typeof api.createSheetsApp).toBe("function");
    expect(typeof api.createTrigger).toBe("function");
  });

  it("exports the vocabulary constants the connector and tests key off", () => {
    expect(api.FAULT_PLANS).toEqual(["calm", "messy", "bulk", "hostile"]);
    expect(api.SHEET_HEADER.length).toBe(9);
    expect(api.COL.email).toBe(1);
    expect(api.METADATA_CHAR_CAP).toBe(30_000);
    expect(api.FREEHAND_DATES.length).toBeGreaterThan(0);
    expect(api.GARBAGE_CURRENCIES.length).toBeGreaterThan(0);
  });
});
