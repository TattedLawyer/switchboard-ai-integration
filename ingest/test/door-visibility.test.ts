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

async function post(body: string, signature: string | undefined): Promise<number> {
  const app = createIngestApp(pool, DEFAULT_TENANT_ID);
  const srv = app.listen(0);
  const port = (srv.address() as { port: number }).port;
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (signature !== undefined) headers["x-switchboard-signature"] = signature;
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/crm`, { method: "POST", headers, body });
    return res.status;
  } finally {
    srv.close();
  }
}

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
