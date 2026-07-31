import { describe, expect, it } from "vitest";
import { generateManifest } from "@switchboard/mock-core";
import { createCasebusApp, REPLAY_PRESETS } from "../src/index.js";

// Task D pair 1 — the event-bus subscribe/replay mock's own truth.
//
// Research contract (phase plan §2 + re-verified 2026-07-31 against the Salesforce
// Pub/Sub API docs; every quoted string below was read from the vendor page, not
// remembered):
//   · event-message-durability: "Salesforce stores platform events and change data
//     capture events for 72 hours."
//   · same page: "Replay ID values aren't guaranteed to be contiguous for consecutive
//     events." — replay ids are CURSORS, never ordinals, never arithmetic.
//   · same page: "On rare occasions, the stream of retained events can be reset if the
//     Salesforce org is moved to a new instance." — cursor invalidation has TWO causes.
//   · Subscribe RPC reference: the ReplayPreset enum is exactly LATEST | EARLIEST |
//     CUSTOM (re-verified spelling and case — the brief required this check).
//   · handling-errors error table: `…fetch.replayid.corrupted` (INVALID_ARGUMENT),
//     "Ensure that the replay_id field value in FetchRequest is valid and refers to an
//     event that is within the retention window"; `…fetch.replayid.validation.failed`
//     (INVALID_ARGUMENT) for CUSTOM with no replay id; `…fetch.requested.events.invalid`
//     (INVALID_ARGUMENT) for a non-positive fetch count.
//
// Modeled over HTTP/JSON, not gRPC/Avro (spec decision D12). The deltas are deliberate
// and documented in src/server.ts: gRPC status codes become HTTP statuses, the Avro
// payload becomes JSON, and the gRPC TRAILER (where the real API puts its status — the
// vendor's own error guide says to read the StatusRuntimeException trailers) becomes the
// final NDJSON frame of the response body. NDJSON is not decoration: it gives every event
// a GENUINE per-event wire text, which is what lets the connector store honest raw_body
// custody instead of a re-serialization.

const app = (opts?: Partial<Parameters<typeof createCasebusApp>[0]>) =>
  createCasebusApp({ seed: 42, ...opts });

type Frame = Record<string, any>;

async function subscribe(
  a: ReturnType<typeof createCasebusApp>,
  qs = "",
): Promise<{ status: number; text: string; frames: Frame[]; body: Frame | null }> {
  const srv = a.app.listen(0);
  const port = (srv.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/subscribe${qs}`);
    const text = await res.text();
    const frames = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Frame);
    return { status: res.status, text, frames, body: res.ok ? null : (frames[0] ?? null) };
  } finally {
    srv.close();
  }
}

async function post(a: ReturnType<typeof createCasebusApp>, path: string, body: unknown) {
  const srv = a.app.listen(0);
  const port = (srv.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Frame };
  } finally {
    srv.close();
  }
}

async function get(a: ReturnType<typeof createCasebusApp>, path: string) {
  const srv = a.app.listen(0);
  const port = (srv.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: (await res.json()) as Frame };
  } finally {
    srv.close();
  }
}

describe("event shape: opaque replay id as CURSOR, separate event uuid as IDENTITY", () => {
  it("every retained event carries an opaque replay_id and a distinct event.id — the two are never the same field", () => {
    const { stream } = app();
    stream.emit(8);
    const events = stream.retained();
    expect(events).toHaveLength(8);
    for (const e of events) {
      expect(e.replay_id).toMatch(/^rpl_[0-9a-z]+$/);
      expect(e.event.id).toMatch(/^cev_[0-9a-z]{24}$/);
      expect(e.replay_id).not.toBe(e.event.id);
      expect(e.event.type).toMatch(/^case\./);
      expect(typeof e.event.event_time).toBe("string");
      expect(Number.isNaN(Date.parse(e.event.event_time))).toBe(false);
      expect(e.event.payload).toBeTypeOf("object");
    }
  });

  it("events draw from the EXISTING manifest support universe (identities correlate with the other sources)", () => {
    const { stream } = app({ seed: 7 });
    stream.emit(24);
    const { tickets, requesters } = generateManifest(7).support;
    const ticketIds = new Set(tickets.map((t) => t.id));
    const requesterIds = new Set(requesters.map((r) => r.id));
    for (const e of stream.retained()) {
      expect(ticketIds.has(String(e.event.payload.case_id))).toBe(true);
      expect(requesterIds.has(String(e.event.payload.requester_id))).toBe(true);
    }
  });

  it("replay ids are NON-CONTIGUOUS by construction: consecutive events never differ by one, so a connector doing arithmetic breaks", () => {
    const { stream } = app({ seed: 3 });
    stream.emit(60);
    const positions = stream.retained().map((e) => parseInt(e.replay_id.slice(4), 36));
    let strideOne = 0;
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]); // ordered, still a cursor
      if (positions[i] - positions[i - 1] === 1) strideOne++;
    }
    // Not "mostly" non-contiguous — never contiguous. cursor+1 is always wrong here.
    expect(strideOne).toBe(0);
  });

  it("is seeded-deterministic: same seed and same script produce identical replay ids", () => {
    const a1 = app({ seed: 11 });
    const a2 = app({ seed: 11 });
    a1.stream.emit(10);
    a2.stream.emit(10);
    expect(a1.stream.retained().map((e) => e.replay_id)).toEqual(a2.stream.retained().map((e) => e.replay_id));
  });
});

describe("subscribe: presets, NDJSON frames, and the trailing status frame (the gRPC trailer's HTTP/JSON translation)", () => {
  it("the preset enum is exactly the vendor's: LATEST | EARLIEST | CUSTOM", () => {
    expect([...REPLAY_PRESETS]).toEqual(["LATEST", "EARLIEST", "CUSTOM"]);
  });

  it("EARLIEST serves the retained window from its start and ends with a status frame naming the stream and has_more", async () => {
    const a = app();
    a.stream.emit(5);
    const res = await subscribe(a, "?replay_preset=EARLIEST&num_requested=100");
    expect(res.status).toBe(200);
    const status = res.frames.at(-1)!;
    expect(status.status.code).toBe("OK");
    expect(status.status.has_more).toBe(false);
    expect(status.status.stream_id).toMatch(/^[0-9a-f-]{36}$/);
    const events = res.frames.slice(0, -1);
    expect(events).toHaveLength(5);
    expect(events.map((f) => f.replay_id)).toEqual(a.stream.retained().map((e) => e.replay_id));
  });

  it("every event frame is its own LINE — genuine per-event wire text, byte-exact and re-parseable", async () => {
    const a = app();
    a.stream.emit(3);
    const res = await subscribe(a, "?replay_preset=EARLIEST&num_requested=100");
    const lines = res.text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(4); // 3 events + the status trailer
    for (const line of lines.slice(0, 3)) {
      expect(line).not.toContain("\n");
      expect(JSON.parse(line).replay_id).toMatch(/^rpl_/);
    }
  });

  it("LATEST serves nothing already retained — it subscribes from the tip", async () => {
    const a = app();
    a.stream.emit(6);
    const res = await subscribe(a, "?replay_preset=LATEST&num_requested=100");
    expect(res.status).toBe(200);
    expect(res.frames.filter((f) => f.replay_id !== undefined)).toHaveLength(0);
    expect(res.frames.at(-1)!.status.has_more).toBe(false);
  });

  it("CUSTOM resumes strictly AFTER the given replay id", async () => {
    const a = app();
    a.stream.emit(10);
    const third = a.stream.retained()[2].replay_id;
    const res = await subscribe(a, `?replay_preset=CUSTOM&replay_id=${third}&num_requested=100`);
    const ids = res.frames.filter((f) => f.replay_id).map((f) => f.replay_id);
    expect(ids).toEqual(a.stream.retained().slice(3).map((e) => e.replay_id));
  });

  it("num_requested bounds the batch and has_more says so — the ONLY termination signal", async () => {
    const a = app();
    a.stream.emit(25);
    const res = await subscribe(a, "?replay_preset=EARLIEST&num_requested=10");
    expect(res.frames.filter((f) => f.replay_id)).toHaveLength(10);
    expect(res.frames.at(-1)!.status.has_more).toBe(true);
  });
});

describe("documented rejections (verbatim error codes from the vendor's error table)", () => {
  it("CUSTOM without a replay id → replayid.validation.failed / INVALID_ARGUMENT", async () => {
    const res = await subscribe(app(), "?replay_preset=CUSTOM");
    expect(res.status).toBe(400);
    expect(res.body!.error.code).toBe("sfdc.platform.eventbus.grpc.subscription.fetch.replayid.validation.failed");
    expect(res.body!.error.status).toBe("INVALID_ARGUMENT");
  });

  it("a non-positive fetch count → requested.events.invalid / INVALID_ARGUMENT", async () => {
    const res = await subscribe(app(), "?replay_preset=EARLIEST&num_requested=0");
    expect(res.status).toBe(400);
    expect(res.body!.error.code).toBe("sfdc.platform.eventbus.grpc.subscription.fetch.requested.events.invalid");
  });

  it("an unknown/aged-out replay id → replayid.corrupted / INVALID_ARGUMENT, with the vendor's own retention wording", async () => {
    const a = app();
    a.stream.emit(2);
    const res = await subscribe(a, "?replay_preset=CUSTOM&replay_id=rpl_deadbeef");
    expect(res.status).toBe(400);
    expect(res.body!.error.code).toBe("sfdc.platform.eventbus.grpc.subscription.fetch.replayid.corrupted");
    expect(res.body!.error.message).toContain("within the retention window");
    // The honest fidelity boundary: the vendor serves ONE code for both causes. The mock
    // refuses to leak a cause hint, so the connector must distinguish structurally.
    expect(JSON.stringify(res.body)).not.toMatch(/reset|retention_age|cause/i);
  });
});

describe("72h retention (the documented window) and the stream reset (the documented second cause)", () => {
  it("an event older than the 72h window is no longer retained, and its replay id is corrupted", async () => {
    const a = app();
    a.stream.emit(3, { ageS: 71 * 3600 });
    const oldId = a.stream.retained()[0].replay_id;
    a.stream.emit(3);
    expect(a.stream.retained()).toHaveLength(6);

    a.stream.advance(2 * 3600); // now the aged batch is 73h old
    expect(a.stream.retained()).toHaveLength(3);
    const res = await subscribe(a, `?replay_preset=CUSTOM&replay_id=${oldId}&num_requested=100`);
    expect(res.status).toBe(400);
    expect(res.body!.error.code).toBe("sfdc.platform.eventbus.grpc.subscription.fetch.replayid.corrupted");
  });

  it("a RESET invalidates every outstanding replay id regardless of age AND mints a new stream_id — the only observable difference from an age-out", async () => {
    const a = app();
    a.stream.emit(5);
    const fresh = a.stream.retained()[1].replay_id;
    const before = a.stream.streamId();

    // Same request, before the reset: perfectly valid.
    expect((await subscribe(a, `?replay_preset=CUSTOM&replay_id=${fresh}&num_requested=100`)).status).toBe(200);

    a.stream.reset();
    const after = a.stream.streamId();
    expect(after).not.toBe(before);
    expect(a.stream.retained()).toHaveLength(0);

    const res = await subscribe(a, `?replay_preset=CUSTOM&replay_id=${fresh}&num_requested=100`);
    expect(res.status).toBe(400);
    // Byte-identical error code to the age-out case — cause is NOT on the wire.
    expect(res.body!.error.code).toBe("sfdc.platform.eventbus.grpc.subscription.fetch.replayid.corrupted");
    // …but the stream identity moved, which IS on the wire (/status and the trailer).
    expect((await subscribe(a, "?replay_preset=EARLIEST&num_requested=10")).frames.at(-1)!.status.stream_id).toBe(after);
  });

  it("a reset does not stop the world: new events flow on the new stream", async () => {
    const a = app();
    a.stream.emit(4);
    a.stream.reset();
    a.stream.emit(6);
    expect(a.stream.retained()).toHaveLength(6);
    const res = await subscribe(a, "?replay_preset=EARLIEST&num_requested=100");
    expect(res.frames.filter((f) => f.replay_id)).toHaveLength(6);
  });
});

describe("at-least-once delivery (the paradigm's own guarantee, as a seeded fault)", () => {
  it("with the duplicate knob on, a subscribe re-serves some events IN the same batch — membership is a superset, never a subset", async () => {
    const a = app({ seed: 5, duplicate: { seed: 5, rate: 1 } });
    a.stream.emit(12);
    const res = await subscribe(a, "?replay_preset=EARLIEST&num_requested=100");
    const served = res.frames.filter((f) => f.replay_id).map((f) => f.event.id);
    const distinct = new Set(served);
    expect(served.length).toBeGreaterThan(distinct.size); // duplicates really happened
    expect([...distinct].sort()).toEqual(a.stream.retained().map((e) => e.event.id).sort());
  });

  it("duplicates are OFF by default — the fault is opt-in, like every other house knob", async () => {
    const a = app();
    a.stream.emit(12);
    const res = await subscribe(a, "?replay_preset=EARLIEST&num_requested=100");
    const served = res.frames.filter((f) => f.replay_id).map((f) => f.event.id);
    expect(new Set(served).size).toBe(served.length);
  });
});

describe("house operator surfaces: /status honesty and /simulate", () => {
  it("/status reports instance_id, freshness, seq and the CURRENT stream_id", async () => {
    const a = app();
    const before = await get(a, "/status");
    expect(before.body.service).toBe("mock-casebus");
    expect(before.body.fresh).toBe(true);
    expect(before.body.seq).toBe(0);
    expect(before.body.instance_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(before.body.stream_id).toBe(a.stream.streamId());

    a.stream.emit(3);
    const after = await get(a, "/status");
    expect(after.body.fresh).toBe(false);
    expect(after.body.seq).toBe(3);
    expect(after.body.instance_id).toBe(before.body.instance_id); // boot identity, not stream identity
  });

  it("/simulate emits, advances the clock, and resets the stream", async () => {
    const a = app();
    expect((await post(a, "/simulate", { count: 4 })).body.emitted).toBe(4);
    expect(a.stream.retained()).toHaveLength(4);

    const streamBefore = a.stream.streamId();
    const reset = await post(a, "/simulate", { reset: true });
    expect(reset.status).toBe(200);
    expect(reset.body.stream_id).not.toBe(streamBefore);
    expect(a.stream.retained()).toHaveLength(0);

    await post(a, "/simulate", { count: 2, age_s: 71 * 3600 });
    await post(a, "/simulate", { advance_s: 2 * 3600 });
    expect(a.stream.retained()).toHaveLength(0); // aged past 72h
  });

  it("/simulate refuses the no-op typos loudly (house rule: an operator flag that silently does nothing is a bug)", async () => {
    const a = app();
    expect((await post(a, "/simulate", {})).status).toBe(400);
    expect((await post(a, "/simulate", { age_s: 100 })).status).toBe(400); // age_s without count
  });
});
