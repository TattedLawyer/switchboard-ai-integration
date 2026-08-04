// CLOSE-3 independents — OPS-I1 and OPS-I3: the two conditions the door detected and the
// operator could not.
//
// The lies: a source that starts emitting a bad field on EVERY event produced HTTP 202 to
// the vendor (so its delivery dashboard stayed green), total silence in the service log, and
// a growing quarantine table — no line to grep, so the condition could not be detected today
// and could not be alerted on tomorrow. And a 401 produced no signal at all, while the
// RUNBOOK prescribes triage steps ("401 on every webhook for one source") that presuppose
// the operator has somehow already observed it.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { createIngestApp } from "../src/server.js";
import { DEFAULT_TENANT_ID } from "../src/ingest-event.js";
import { classifyRejection, secretForSource, signBody } from "../src/hmac.js";
import { SOURCES } from "../src/sources.js";

let pool: pg.Pool;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  cleanup = result.cleanup;
});
afterAll(async () => {
  await cleanup();
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function postTo(source: string, body: string, signature: string | undefined): Promise<number> {
  const app = createIngestApp(pool, DEFAULT_TENANT_ID);
  const srv = app.listen(0);
  const port = (srv.address() as { port: number }).port;
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (signature !== undefined) headers["x-switchboard-signature"] = signature;
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/${source}`, { method: "POST", headers, body });
    return res.status;
  } finally {
    srv.close();
  }
}

const post = (body: string, signature: string | undefined): Promise<number> => postTo("crm", body, signature);

describe("OPS-I1 — quarantine at the door is on the service log", () => {
  it("a schema-failure divert warns, naming the source, the event and the reason", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = JSON.stringify({ event_id: "evt-i1-visible", bogus: true });
    expect(await post(body, signBody(body, secretForSource("crm")))).toBe(202);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    const line = lines.find((l) => l.includes("quarantined") && l.includes("evt-i1-visible"));
    expect(line, `no quarantine warning in: ${JSON.stringify(lines)}`).toBeDefined();
    expect(line).toContain("crm");
    expect(line).toContain("schema validation failed");
  });

  it("a jsonb-unstorable divert warns too — the other divert must not be the silent one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A lone surrogate: valid JSON, passes the signature, unstorable as jsonb.
    const body = '{"event_id":"evt-i1-nul","data":{"name":"\\ud800"}}';
    expect(await post(body, signBody(body, secretForSource("crm")))).toBe(202);
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("quarantined"));
    expect(line).toBeDefined();
    expect(line).toContain("crm");
  });
});

// Gate-H I2. The OPS-I1 fix above was applied to `/webhooks/:source` and to nothing
// else — and the tests above only ever posted to `/webhooks/crm`, the RETIRED legacy
// lane, so the pin passed whether or not the fix existed anywhere that matters. The
// hubcrm batch door (server.ts short-circuits to handleHubcrmBatch BEFORE the logged
// code runs) reproduced the exact OPS-I1 condition on the one push source the demo
// drives at volume: 202 to the vendor, a growing quarantine table, nothing to grep.
//
// That is the third defect of this shape in one week — a fix applied to one member of a
// family with the siblings missed, and the test covering only the fixed member. So this
// suite is now driven off SOURCES itself: every registered source's door is posted a
// payload that must quarantine, and every one of them must produce a log line. A new
// source registered without a log line on its door fails here, without anyone having
// remembered to add a case.
describe("OPS-I1, every door — a source registered without a visible quarantine fails here", () => {
  // The one shape difference between the doors: hubcrm delivers BATCHES (a JSON array),
  // so a bare object is a 400 at its door rather than a quarantine. Everything else goes
  // through the generic per-event door.
  // ...and the vendor field names differ with it: hubcrm's wire shape is HubSpot's
  // (`eventId` / `subscriptionType`), mapped to the house shape by mapThinEvent.
  const bodyFor = (source: string, eventId: string): string =>
    source === "hubcrm"
      ? JSON.stringify([{ eventId, subscriptionType: "company.propertyChange", bogus: true }])
      : JSON.stringify({ event_id: eventId, bogus: true });

  // sheets has no generic event door BY DESIGN (its raw lane is connector-born; a
  // foreign event_id minted there poisons every later diff), so it has no door to be
  // silent at. Asserted rather than skipped — "this source has no event door" is a claim
  // that must red if it ever stops being true and a door appears with no log line.
  it("sheets has no event door to be silent at — its only push surface is the nudge", async () => {
    const body = JSON.stringify({ event_id: "evt-i2-sheets", bogus: true });
    expect(await postTo("sheets", body, signBody(body, secretForSource("sheets")))).not.toBe(202);
  });

  for (const source of SOURCES.filter((s) => s !== "sheets")) {
    it(`${source}: a schema-failure divert reaches the service log`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const eventId = `evt-i2-${source}`;
      const body = bodyFor(source, eventId);
      expect(await postTo(source, body, signBody(body, secretForSource(source)))).toBe(202);
      const lines = warn.mock.calls.map((c) => String(c[0]));
      const line = lines.find((l) => l.includes("quarantined") && l.includes(source));
      expect(line, `${source}: no quarantine warning in: ${JSON.stringify(lines)}`).toBeDefined();
      expect(line, `${source}: the line must name the reason, not just the fact`).toContain(
        "schema validation failed",
      );
      expect(line, `${source}: the line must name the event an operator has to go find`).toContain(eventId);
    });

    it(`${source}: a jsonb-unstorable divert reaches the service log too`, async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // A lone surrogate: valid JSON, passes the signature, unstorable as jsonb. The
      // other divert must not be the silent one — a source that starts emitting a NUL
      // in every payload is exactly the "bad field on EVERY event" case OPS-I1 names.
      const inner = `{"event_id":"evt-i2u-${source}","event_type":"x","data":{"name":"\\ud800"}}`;
      const body = source === "hubcrm" ? `[${inner}]` : inner;
      expect(await postTo(source, body, signBody(body, secretForSource(source)))).toBe(202);
      const lines = warn.mock.calls.map((c) => String(c[0]));
      const line = lines.find((l) => l.includes("quarantined") && l.includes(source));
      expect(line, `${source}: no quarantine warning in: ${JSON.stringify(lines)}`).toBeDefined();
    });
  }
});

describe("OPS-I3 — signature rejections are visible on the operator's side", () => {
  it("classifyRejection separates the incidents that need different remedies", () => {
    const body = '{"event_id":"evt"}';
    const secret = secretForSource("crm");
    const now = Math.floor(Date.now() / 1000);
    expect(classifyRejection(body, undefined, secret)).toBe("missing signature header");
    expect(classifyRejection(body, "garbage", secret)).toBe("malformed signature header");
    // Correctly signed, but 10 minutes old: clock skew, NOT a wrong secret.
    expect(classifyRejection(body, signBody(body, secret, now - 600), secret)).toContain("tolerance");
    // Correct timestamp, wrong secret.
    expect(classifyRejection(body, signBody(body, "not-the-secret", now), secret)).toContain(
      "wrong or rotated secret",
    );
  });

  it("a 401 warns, naming the source and the rejection class — and never the signature or body", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = JSON.stringify({ event_id: "evt-i3-secret-payload" });
    const forged = signBody(body, "not-the-secret");
    expect(await post(body, forged)).toBe(401);
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("401"));
    expect(line).toBeDefined();
    expect(line).toContain("crm");
    expect(line).toContain("wrong or rotated secret");
    // The two things that must never reach a log line.
    expect(line).not.toContain(forged);
    expect(line).not.toContain("evt-i3-secret-payload");
  });
});
