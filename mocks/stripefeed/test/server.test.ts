import { describe, expect, it } from "vitest";
import { generateManifest } from "@switchboard/mock-core";
import { createStripeFeedApp, type FeedEvent } from "../src/index.js";

// Task B pair 1 — the Stripe-STYLE events feed's own truth.
//
// Research contract (phase plan §2, verbatim-verified 2026-07-29): full-object envelope
// events; `limit` 1–100 default 10; `starting_after` object-id cursor; `has_more`;
// events retrievable for 30 days; response ordering NOT documented. The mock is honest
// about each of those properties — including the undocumented one, which it exploits by
// SHUFFLING within pages under a seeded flag so a connector that trusts response order
// breaks in tests instead of in production.

const app = (opts?: Partial<Parameters<typeof createStripeFeedApp>[0]>) =>
  createStripeFeedApp({ seed: 42, ...opts });

async function getPage(
  a: ReturnType<typeof createStripeFeedApp>,
  qs = "",
): Promise<{ status: number; body: any }> {
  // In-process: drive the express app on an ephemeral listener per call.
  const srv = a.app.listen(0);
  const port = (srv.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/events${qs}`);
    return { status: res.status, body: await res.json() };
  } finally {
    srv.close();
  }
}

describe("envelope shape (research: full object in data.object, opaque evt_ ids, s-epoch created)", () => {
  it("emits envelopes { id: evt_<opaque>, object: 'event', type, created: s-epoch, data: { object } }", () => {
    const { feed } = app();
    feed.emit(8);
    const events = feed.retained();
    expect(events).toHaveLength(8);
    for (const e of events) {
      expect(e.id).toMatch(/^evt_[0-9a-z]{24}$/);
      expect(e.object).toBe("event");
      expect(e.type).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(Number.isInteger(e.created)).toBe(true);
      // s-epoch, not ms: a plausible 2020s timestamp in SECONDS is ~1.7e9, in ms ~1.7e12.
      expect(e.created).toBeLessThan(10_000_000_000);
      expect(e.data.object).toBeTypeOf("object");
    }
  });

  it("ids are OPAQUE and non-ordinal: emission order is not recoverable from the ids (the point of the paradigm)", () => {
    const { feed } = app();
    feed.emit(40);
    const ids = feed.retained().map((e) => e.id);
    const sorted = [...ids].sort();
    expect(sorted).not.toEqual(ids); // lexicographic order ≠ emission order
    expect(new Set(ids).size).toBe(40); // and still unique
  });

  it("draws resources from the SAME manifest universe as the 2a billing mock, so identities correlate later", () => {
    const { feed } = app();
    feed.emit(16); // 4 full script cycles
    const { customers, invoices } = generateManifest(42).billing;
    const byType = (t: string) => feed.retained().filter((e) => e.type === t);
    expect((byType("customer.created")[0].data.object as { id: string }).id).toBe(customers[0].id);
    expect((byType("invoice.finalized")[0].data.object as { id: string }).id).toBe(invoices[0].id);
    const charge = byType("charge.succeeded")[0].data.object as Record<string, unknown>;
    expect(charge.invoice_id).toBe(invoices[0].id);
    expect(charge.customer_id).toBe(invoices[0].customer_id);
    expect(charge.amount_cents).toBe(invoices[0].amount_cents);
    expect(charge.currency).toBe("USD");
    // hygiene: everything DEMO-prefixed, straight from the manifest
    for (const e of feed.retained()) {
      expect(String((e.data.object as { id: string }).id)).toMatch(/^DEMO-/);
    }
  });

  it("is seed-deterministic: same seed → identical event stream; different seed → different ids", () => {
    const a = app();
    const b = app();
    const c = app({ seed: 7 });
    a.feed.emit(12);
    b.feed.emit(12);
    c.feed.emit(12);
    expect(b.feed.retained().map((e) => e.id)).toEqual(a.feed.retained().map((e) => e.id));
    expect(c.feed.retained().map((e) => e.id)).not.toEqual(a.feed.retained().map((e) => e.id));
  });
});

describe("GET /v1/events — pagination per the researched contract", () => {
  it("defaults limit to 10 and reports has_more", async () => {
    const a = app();
    a.feed.emit(25);
    const { status, body } = await getPage(a);
    expect(status).toBe(200);
    expect(body.object).toBe("list");
    expect(body.data).toHaveLength(10);
    expect(body.has_more).toBe(true);
  });

  it("walks the whole feed via starting_after + has_more, exact page boundary included (6 events / limit 3 → second page has_more=false)", async () => {
    const a = app();
    a.feed.emit(6);
    const p1 = await getPage(a, "?limit=3");
    expect(p1.body.data).toHaveLength(3);
    expect(p1.body.has_more).toBe(true);
    // Cursor = the response array's last element. Valid ONLY because this app has no
    // shuffle flag, so pages serve window order — this test walks the MOCK's window
    // mechanics exactly. A connector can never assume this (shuffle + same-second
    // created ties make window position unrecoverable); its order-blind cursor choice
    // and the resulting harmless re-serves are pinned in ingest/test/stripe-feed.test.ts.
    const p2 = await getPage(a, `?limit=3&starting_after=${p1.body.data.at(-1)!.id}`);
    expect(p2.body.data).toHaveLength(3);
    expect(p2.body.has_more).toBe(false);
    const seen = new Set([...p1.body.data, ...p2.body.data].map((e: FeedEvent) => e.id));
    expect(seen.size).toBe(6);
  });

  it("rejects limit outside 1–100 (and non-numeric) with a Stripe-shaped invalid_request_error naming the param", async () => {
    const a = app();
    a.feed.emit(2);
    for (const bad of ["0", "101", "abc"]) {
      const { status, body } = await getPage(a, `?limit=${bad}`);
      expect(status).toBe(400);
      expect(body.error.type).toBe("invalid_request_error");
      expect(body.error.param).toBe("limit");
    }
  });

  it("answers an unknown starting_after id with the documented 400 shape: invalid_request_error / resource_missing / param starting_after", async () => {
    const a = app();
    a.feed.emit(3);
    const { status, body } = await getPage(a, "?starting_after=evt_000000000000000000000000");
    expect(status).toBe(400);
    expect(body.error).toMatchObject({
      type: "invalid_request_error",
      code: "resource_missing",
      param: "starting_after",
    });
    expect(body.error.message).toMatch(/No such event: 'evt_000000000000000000000000'/);
    expect(body.error.doc_url).toMatch(/^https:\/\//);
  });
});

describe("response ordering is deliberately NOT guaranteed (research: undocumented)", () => {
  it("under the seeded shuffle flag, a page is a permutation of the window — same members, different order", async () => {
    const plain = app();
    const shuffled = app({ shuffle: { seed: 9 } });
    plain.feed.emit(30);
    shuffled.feed.emit(30);
    const p = await getPage(plain, "?limit=30");
    const s = await getPage(shuffled, "?limit=30");
    const ids = (b: { data: FeedEvent[] }) => b.data.map((e) => e.id);
    expect(new Set(ids(s.body))).toEqual(new Set(ids(p.body)));
    expect(ids(s.body)).not.toEqual(ids(p.body));
  });

  it("the shuffle is seed-deterministic: identical request sequences see identical orders", async () => {
    const a = app({ shuffle: { seed: 9 } });
    const b = app({ shuffle: { seed: 9 } });
    a.feed.emit(20);
    b.feed.emit(20);
    const pa = await getPage(a, "?limit=20");
    const pb = await getPage(b, "?limit=20");
    expect(pa.body.data.map((e: FeedEvent) => e.id)).toEqual(pb.body.data.map((e: FeedEvent) => e.id));
  });
});

describe("30-day retention — the paradigm's honest data-loss boundary (mock clock, seeded)", () => {
  it("events older than 30 days vanish from the feed", async () => {
    const a = app();
    a.feed.emit(4, { ageS: 29 * 86_400 }); // 29 days old: still retrievable
    a.feed.emit(3); // fresh
    expect(a.feed.retained()).toHaveLength(7);
    a.feed.advance(2 * 86_400); // now the first batch is 31 days old
    const retained = a.feed.retained();
    expect(retained).toHaveLength(3);
    const { body } = await getPage(a, "?limit=100");
    expect(body.data.map((e: FeedEvent) => e.id).sort()).toEqual(retained.map((e) => e.id).sort());
  });

  it("a starting_after cursor that has AGED OUT returns the same resource_missing 400 as a never-existed id — the connector cannot tell the difference, by design", async () => {
    const a = app();
    a.feed.emit(2, { ageS: 29 * 86_400 });
    a.feed.emit(2);
    const agedId = a.feed.retained()[0].id;
    a.feed.advance(2 * 86_400);
    const { status, body } = await getPage(a, `?starting_after=${agedId}`);
    expect(status).toBe(400);
    expect(body.error.code).toBe("resource_missing");
    expect(body.error.param).toBe("starting_after");
  });

  it("refuses an emission that would make created REGRESS — the feed appends, history never interleaves", () => {
    const a = app();
    a.feed.emit(1);
    expect(() => a.feed.emit(1, { ageS: 86_400 })).toThrow(/regress/i);
  });
});

describe("house conventions — /simulate and /status process honesty", () => {
  it("POST /simulate advances the stream (and optionally the clock) and reports seq", async () => {
    const a = app();
    const srv = a.app.listen(0);
    const port = (srv.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/simulate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count: 5 }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ emitted: 5, seq: 5 });
      const adv = await fetch(`http://127.0.0.1:${port}/simulate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ advance_s: 31 * 86_400 }),
      });
      expect(adv.status).toBe(200);
      expect(a.feed.retained()).toHaveLength(0); // the 5 events aged out
      const bad = await fetch(`http://127.0.0.1:${port}/simulate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count: 0 }),
      });
      expect(bad.status).toBe(400);
    } finally {
      srv.close();
    }
  });

  it("GET /status tells the truth about freshness: instance_id, fresh flips after the first emission, seq counts emissions", async () => {
    const a = app();
    const srv = a.app.listen(0);
    const port = (srv.address() as { port: number }).port;
    try {
      const before = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
      expect(before).toMatchObject({ service: "mock-stripefeed", fresh: true, seq: 0 });
      expect(before.instance_id).toMatch(/[0-9a-f-]{36}/);
      a.feed.emit(2);
      const after = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
      expect(after).toMatchObject({ fresh: false, seq: 2 });
    } finally {
      srv.close();
    }
  });
});

describe("seeded 429 fault injection (house pattern from mocks/sheets)", () => {
  it("answers the configured fraction of reads with a Stripe-shaped rate_limit_error, deterministically", async () => {
    const a = app({ read429: { seed: 5, rate: 1 } });
    a.feed.emit(2);
    const { status, body } = await getPage(a, "?limit=10");
    expect(status).toBe(429);
    // Legacy wire type by deliberate choice (see server.ts's enum-drift note);
    // code "rate_limit" is the currently-documented error code for this condition.
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.code).toBe("rate_limit");
  });
});
