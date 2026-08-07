// PRE-3 / #15 (gate-H I11) — "a disabled source's webhook door stays armed".
//
// The lie: `validateWebhookSource` admitted any member of the seven-element `SOURCES`
// registry and knew nothing about `enabledSources()`, which gated only backfill,
// hydration and reconcile. On any non-default `INGEST_SOURCES` that gave two conditions,
// both of them dishonest:
//
//   · secret still configured → `/webhooks/<disabled>` kept accepting and INGESTING into
//     a lane no backfill and no reconcile covers. Ingest with no zero-loss surface behind
//     it, which is the repo's headline claim quietly not applying to that lane.
//   · secret absent → `secretForSource` threw INSIDE the handler, the catch-all answered
//     500 and logged server-side on every anonymous POST. That is the prober-noise class
//     the sheets nudge door was fixed for, and the nudge fix's own comment asserts "the
//     event doors never had this shape because their secrets are boot-asserted exactly
//     when their source is enabled" — false for a *disabled* source's still-mounted door.
//
// 404 is the answer, not 410/503/403. RFC 9110 defines 404 as "the server cannot find a
// current representation for the target resource or is unwilling to disclose that one
// exists"; 410 means "likely to be permanent", which is a false claim about a reversible
// env setting; 503 asserts a temporary condition that will not clear on its own; and 403
// carries the spec's own instruction that "a server that wishes to hide the existence of
// a resource should use a 404 status instead". Retry hazard checked against real vendors
// before choosing: Stripe retries non-2xx "for up to three days with an exponential back
// off" and lists 404 among the bounded 4xx failures; GitHub "does not automatically
// redeliver failed deliveries". Neither punishes 404 with unbounded retry, and the only
// code that avoids retry entirely — 2xx — would be a lie, since no ingest follows.
//
// ORDERING: this fix rides BEHIND batch A on purpose. Mounting doors over
// `enabledSources()` while that function could silently return `[]` on a typo would make
// every door vanish for a deployment that believes every source is on. Batch A made that
// a boot refusal first.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { createIngestApp } from "../src/server.js";
import { DEFAULT_TENANT_ID } from "../src/ingest-event.js";
import { secretForSource, signBody } from "../src/hmac.js";
import type { Source } from "../src/sources.js";
import { listenLoopback } from "@switchboard/mock-core";

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

interface Reply {
  status: number;
  body: unknown;
}

/** POST to `path` on an app whose deployment serves exactly `enabled`. */
async function postTo(
  enabled: readonly Source[],
  path: string,
  body: string,
  signature: string | undefined,
): Promise<Reply> {
  const app = createIngestApp(pool, DEFAULT_TENANT_ID, { enabledSources: enabled });
  const srv = await listenLoopback(app);
  const port = (srv.address() as { port: number }).port;
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (signature !== undefined) headers["x-switchboard-signature"] = signature;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers, body });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    srv.close();
  }
}

const rawCount = async (source: string, eventId: string): Promise<number> => {
  const r = await pool.query(
    `select count(*)::int as n from raw.raw_events where source = $1 and event_id = $2`,
    [source, eventId],
  );
  return r.rows[0].n as number;
};

describe("PRE-3 #15 — the event door is mounted over the ENABLED sources, not the registry", () => {
  // Case 1 — enabled + registered: nothing about this door changed.
  it("case 1 · an ENABLED source's door behaves exactly as before (202 signed, 401 unsigned, 400 malformed)", async () => {
    const enabled: Source[] = ["billing", "crm"];
    const ev = JSON.stringify({
      event_id: "evt-pre3-enabled",
      event_type: "invoice.created",
      occurred_at: new Date().toISOString(),
      // amount_cents present: the L1 numeric contract declares it required for
      // invoice.created, and this case must prove the event really STORED.
      data: { id: "DEMO-PRE3-0001", amount_cents: 12500 },
    });
    const ok = await postTo(enabled, "/webhooks/billing", ev, signBody(ev, secretForSource("billing")));
    expect(ok.status).toBe(202);
    expect(await rawCount("billing", "evt-pre3-enabled")).toBe(1);

    expect((await postTo(enabled, "/webhooks/billing", ev, undefined)).status).toBe(401);
    const bad = await postTo(enabled, "/webhooks/billing", "{not json", signBody("{not json", secretForSource("billing")));
    expect(bad.status).toBe(400);
  });

  // Case 2 — registered but NOT in INGEST_SOURCES.
  it("case 2 · a REGISTERED-but-DISABLED source answers 404, ingests nothing, and says which kind of 404 it is", async () => {
    const enabled: Source[] = ["billing"];
    const ev = JSON.stringify({
      event_id: "evt-pre3-disabled",
      event_type: "case.created",
      occurred_at: new Date().toISOString(),
      data: { id: "DEMO-PRE3-0002" },
    });
    // Correctly signed, and STILL refused — the door is absent, not unauthenticated.
    const reply = await postTo(enabled, "/webhooks/support", ev, signBody(ev, secretForSource("support")));
    expect(reply.status).toBe(404);
    expect(reply.body).toEqual({ error: "source not served by this deployment" });
    // The whole point: no ingest into a lane no backfill and no reconcile covers.
    expect(await rawCount("support", "evt-pre3-disabled")).toBe(0);
  });

  it("case 2b · an anonymous unsigned POST to a disabled source's door is a quiet 404 — no 500, no server-side log", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const reply = await postTo(["billing"], "/webhooks/support", "{}", undefined);
      expect(reply.status).toBe(404);
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  // Case 3 — the pre-existing unknown-source 404 must survive the new branch.
  it("case 3 · an UNREGISTERED source keeps its own 404 body — the new branch did not swallow the old one", async () => {
    const reply = await postTo(["billing"], "/webhooks/hubspot", "{}", undefined);
    expect(reply.status).toBe(404);
    expect(reply.body).toEqual({ error: "unknown source" });
  });

  it("the two 404s are distinguishable in TEXT — an operator can tell 'never existed' from 'turned off here'", async () => {
    const unknown = await postTo(["billing"], "/webhooks/hubspot", "{}", undefined);
    const disabled = await postTo(["billing"], "/webhooks/support", "{}", undefined);
    expect(unknown.status).toBe(disabled.status);
    expect(unknown.body).not.toEqual(disabled.body);
  });

  // FAMILY SWEEP, pinned rather than remembered. This repo's most-repeated defect is a
  // fix applied to one member of a family with the siblings missed. `server.ts` mounts
  // exactly TWO push doors — `/webhooks/:source` and `/connectors/sheets/nudge` — and
  // both must obey the same rule. The nudge door already 404s when no secret resolves;
  // that is not the same condition as "sheets is not in INGEST_SOURCES", and a
  // sheets-secret-configured deployment that has turned sheets OFF had an armed nudge.
  it("family · the sheets NUDGE door obeys the same rule — disabled sheets is an absent route even with the secret set", async () => {
    const nudge = JSON.stringify({ sheet_id: "s1", range: "A1:Z9", occurred_at: new Date().toISOString() });
    const off = await postTo(["billing"], "/connectors/sheets/nudge", nudge, signBody(nudge, secretForSource("sheets")));
    expect(off.status).toBe(404);
    expect(off.body).toEqual({ error: "source not served by this deployment" });

    // ...and with sheets ENABLED the door is reachable again: authenticated, but unwired
    // in this process, which is the pre-existing honest 503 rather than a 404.
    const on = await postTo(["sheets"], "/connectors/sheets/nudge", nudge, signBody(nudge, secretForSource("sheets")));
    expect(on.status).toBe(503);
  });

  // The event door's OTHER refusal for sheets is a different claim and must survive:
  // sheets is enabled here, and its generic event door is still closed BY NAME because
  // its raw lane is connector-born.
  it("family · an ENABLED sheets still has no generic event door — the by-name refusal is not the disabled refusal", async () => {
    const reply = await postTo(["sheets"], "/webhooks/sheets", "{}", undefined);
    expect(reply.status).toBe(404);
    expect(reply.body).toEqual({
      error: "sheets has no event door; its push surface is POST /connectors/sheets/nudge",
    });
  });
});

describe("PRE-3 #15 — DLQ scans deliberately keep iterating the whole registry", () => {
  // Recorded as a decision, not an oversight: `queue.ts` scans dead letters over
  // `SOURCES`, and it must keep doing so. A source that was disabled AFTER events had
  // already dead-lettered still has a DLQ that needs draining, and a drain surface that
  // disappears the moment the source is turned off would strand exactly the events an
  // operator turned the source off to go deal with. Mounting the DOOR over the enabled
  // set closes the new-ingest hole; narrowing the DRAIN would open a worse one.
  it("is a decision recorded in the source, so a future sweep does not 'finish the job'", async () => {
    const { readFileSync } = await import("node:fs");
    const queueSrc = readFileSync(new URL("../src/queue.ts", import.meta.url), "utf8");
    expect(queueSrc).toMatch(/PRE-3 \(#15\), DELIBERATE AND NOT AN OVERSIGHT/);
    expect(queueSrc).toMatch(/existing dead letters still need\n\/\/ draining/);
  });
});
