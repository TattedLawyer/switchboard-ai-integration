import { afterEach, describe, expect, it } from "vitest";
import { SOURCES, isSource, baseUrlFor, enabledSources, ledgerPathFor } from "../src/sources.js";

afterEach(() => {
  delete process.env.INGEST_SOURCES;
  delete process.env.BILLING_BASE_URL;
  delete process.env.SHEETS_BASE_URL;
  delete process.env.LEDGER_PATH_SUPPORT;
});

describe("source registry", () => {
  // SPEC CHANGE (A5, deliberate): membership grew crm/billing/support → +sheets. The
  // sheet-snapshot connector (A4) becomes a first-class source here because everything
  // registration needs — the base-URL env convention, the per-source webhook secret for
  // the nudge door (D3: secretForSource is typed over this union), the default port —
  // hangs off `Source`. The pin stays exact-member on purpose: the NEXT source must be
  // this same kind of visible, reviewed act. Growth is the event this test gates.
  // SPEC CHANGE (Task B, deliberate): membership grew again → +stripefeed, the
  // Stripe-STYLE cursor-feed source. Same A5 reasoning: registration is what hangs the
  // deployment surface (STRIPEFEED_BASE_URL, port 4006, INGEST_SOURCES opt-in, the
  // connector registry arm) off `Source`. Pull-only paradigm — its webhook door and
  // queue exist as inert registry consequences and are documented as unused (RUNBOOK).
  it("knows exactly crm, billing, support, sheets, stripefeed", () => {
    expect([...SOURCES]).toEqual(["crm", "billing", "support", "sheets", "stripefeed"]);
    expect(isSource("crm")).toBe(true);
    expect(isSource("sheets")).toBe(true);
    expect(isSource("stripefeed")).toBe(true);
    expect(isSource("hubspot")).toBe(false);
  });
  it("defaults base URLs to the documented ports and honors env overrides", () => {
    expect(baseUrlFor("crm")).toBe("http://localhost:4001");
    expect(baseUrlFor("billing")).toBe("http://localhost:4003");
    expect(baseUrlFor("support")).toBe("http://localhost:4004");
    // A5: 4005 is the sheets mock's own documented default (mocks/sheets/src/main.ts).
    expect(baseUrlFor("sheets")).toBe("http://localhost:4005");
    // Task B: 4006 is the stripefeed mock's documented default (mocks/stripefeed/src/main.ts).
    expect(baseUrlFor("stripefeed")).toBe("http://localhost:4006");
    process.env.BILLING_BASE_URL = "http://127.0.0.1:9999";
    expect(baseUrlFor("billing")).toBe("http://127.0.0.1:9999");
    process.env.SHEETS_BASE_URL = "http://127.0.0.1:9998";
    expect(baseUrlFor("sheets")).toBe("http://127.0.0.1:9998");
  });
  it("INGEST_SOURCES filters to known sources; the DEFAULT stays the feed trio — sheets is enabled only when configured", () => {
    // SPEC CHANGE (A5): sheets joined SOURCES but NOT the default enabled set. The
    // default drives main.ts's feed-shaped interval backfill and the demo scripts —
    // surfaces a snapshot source has no business in uninvited (it has no /events feed
    // to poll). Opting in via INGEST_SOURCES also makes WEBHOOK_SECRET_SHEETS a boot
    // requirement exactly where the source is actually on, and nowhere else.
    expect(enabledSources()).toEqual(["crm", "billing", "support"]);
    process.env.INGEST_SOURCES = "crm, bogus ,support";
    expect(enabledSources()).toEqual(["crm", "support"]);
    process.env.INGEST_SOURCES = "crm,sheets";
    expect(enabledSources()).toEqual(["crm", "sheets"]);
    // Task B: stripefeed follows the sheets posture exactly — registered, never default.
    // Its /v1/events feed is not the /events shape main.ts's interval loop polls blind;
    // a deployment opts in explicitly and the seam routes it through its own connector.
    process.env.INGEST_SOURCES = "billing,stripefeed";
    expect(enabledSources()).toEqual(["billing", "stripefeed"]);
  });
  it("ledgerPathFor reads LEDGER_PATH_<SOURCE>", () => {
    expect(ledgerPathFor("support")).toBeUndefined();
    process.env.LEDGER_PATH_SUPPORT = "/tmp/s.jsonl";
    expect(ledgerPathFor("support")).toBe("/tmp/s.jsonl");
  });
});
