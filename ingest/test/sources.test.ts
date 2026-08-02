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
  // SPEC CHANGE (Task C, deliberate): membership grew again → +hubcrm, the
  // HubSpot-STYLE thin-webhook + hydration source. Registration hangs the deployment
  // surface (HUBCRM_BASE_URL, port 4007, INGEST_SOURCES opt-in, WEBHOOK_SECRET_HUBCRM
  // as a boot requirement when enabled, the connector registry arm) off `Source`. It
  // lands ALONGSIDE the 2a crm mock (risk rule: nothing rewritten in place; Task F
  // owns the old CRM's retirement).
  // SPEC CHANGE (Task D, deliberate): membership grew again → +casebus, the event-bus
  // SUBSCRIBE/REPLAY support source. Registration hangs the deployment surface
  // (CASEBUS_BASE_URL, port 4008, INGEST_SOURCES opt-in, WEBHOOK_SECRET_CASEBUS as a
  // boot requirement when enabled, the connector registry arm) off `Source`. Subscribe-
  // only paradigm — like stripefeed its webhook door and queue exist as inert registry
  // consequences and are documented as unused (RUNBOOK). It lands ALONGSIDE the 2a
  // support mock (risk rule: nothing rewritten in place; Task F owns the switch).
  it("knows exactly crm, billing, support, sheets, stripefeed, hubcrm, casebus", () => {
    expect([...SOURCES]).toEqual(["crm", "billing", "support", "sheets", "stripefeed", "hubcrm", "casebus"]);
    expect(isSource("casebus")).toBe(true);
    expect(isSource("crm")).toBe(true);
    expect(isSource("sheets")).toBe(true);
    expect(isSource("stripefeed")).toBe(true);
    expect(isSource("hubcrm")).toBe(true);
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
    // Task C: 4007 is the hubcrm mock's documented default (mocks/hubcrm/src/main.ts).
    expect(baseUrlFor("hubcrm")).toBe("http://localhost:4007");
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
    expect(enabledSources()).toEqual(["billing", "support"]); // F-1c: crm mock retired, no longer default-enabled
    process.env.INGEST_SOURCES = "crm, bogus ,support";
    expect(enabledSources()).toEqual(["crm", "support"]);
    process.env.INGEST_SOURCES = "crm,sheets";
    expect(enabledSources()).toEqual(["crm", "sheets"]);
    // Task B: stripefeed follows the sheets posture exactly — registered, never default.
    // Its /v1/events feed is not the /events shape main.ts's interval loop polls blind;
    // a deployment opts in explicitly and the seam routes it through its own connector.
    process.env.INGEST_SOURCES = "billing,stripefeed";
    expect(enabledSources()).toEqual(["billing", "stripefeed"]);
    // Task C: hubcrm follows the same posture — registered, never default. Its push
    // channel is the batch webhook door; its catchUp is a hydration pump, not a feed
    // poll — nothing main.ts's default trio wiring should ever drive uninvited.
    process.env.INGEST_SOURCES = "crm,hubcrm";
    expect(enabledSources()).toEqual(["crm", "hubcrm"]);
  });
  it("ledgerPathFor reads LEDGER_PATH_<SOURCE>", () => {
    expect(ledgerPathFor("support")).toBeUndefined();
    process.env.LEDGER_PATH_SUPPORT = "/tmp/s.jsonl";
    expect(ledgerPathFor("support")).toBe("/tmp/s.jsonl");
  });
});
