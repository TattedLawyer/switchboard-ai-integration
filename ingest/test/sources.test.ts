import { afterEach, describe, expect, it } from "vitest";
import { SOURCES, isSource, baseUrlFor, enabledSources, ledgerPathFor } from "../src/sources.js";

afterEach(() => {
  delete process.env.INGEST_SOURCES;
  delete process.env.BILLING_BASE_URL;
  delete process.env.LEDGER_PATH_SUPPORT;
});

describe("source registry", () => {
  it("knows exactly crm, billing, support", () => {
    expect([...SOURCES]).toEqual(["crm", "billing", "support"]);
    expect(isSource("crm")).toBe(true);
    expect(isSource("hubspot")).toBe(false);
  });
  it("defaults base URLs to the documented ports and honors env overrides", () => {
    expect(baseUrlFor("crm")).toBe("http://localhost:4001");
    expect(baseUrlFor("billing")).toBe("http://localhost:4003");
    expect(baseUrlFor("support")).toBe("http://localhost:4004");
    process.env.BILLING_BASE_URL = "http://127.0.0.1:9999";
    expect(baseUrlFor("billing")).toBe("http://127.0.0.1:9999");
  });
  it("INGEST_SOURCES filters to known sources; default is all", () => {
    expect(enabledSources()).toEqual(["crm", "billing", "support"]);
    process.env.INGEST_SOURCES = "crm, bogus ,support";
    expect(enabledSources()).toEqual(["crm", "support"]);
  });
  it("ledgerPathFor reads LEDGER_PATH_<SOURCE>", () => {
    expect(ledgerPathFor("support")).toBeUndefined();
    process.env.LEDGER_PATH_SUPPORT = "/tmp/s.jsonl";
    expect(ledgerPathFor("support")).toBe("/tmp/s.jsonl");
  });
});
