// Family 3 / review I-2 — the crm→door reply contract, as a PURE function.
//
// The production `crm→door` adapter does not exist and is NOT built here. What is built is
// the piece the future adapter must not get wrong, because Family 3's whole heal rests on
// it: the door is idempotent on `(tenant_id, idempotency_key)`, and EVERY id-bearing reply
// carries the authoritative id — 201 fresh insert, 200 live replay, and 409 TERMINAL replay
// (`approval/src/server.ts:78-90`, id at `:84`). A frozen key means the retry re-POSTs the
// same key; if the adapter throws on the 409 instead of resolving the id, the heal becomes a
// per-cycle throw loop and the zero-action orphan is never closable by the close pass.
//
// 🚨 THE BUG THIS EXISTS TO PREVENT IS ALREADY IN THE TREE, one workspace over: the agent's
// client throws on ANY non-2xx (`agent/src/host/propose.ts:147-154`), which would drop the
// 409's id. Copying it into the crm adapter would re-silence the rejected-before-recorded
// case. That is why this is a tested module and not a comment.
import { describe, it, expect } from "vitest";
import { interpretDoorReply, DoorReplyError } from "../src/door-reply.js";

const ID = "11111111-2222-3333-4444-555555555555";

describe("interpretDoorReply — every id-bearing reply resolves the id", () => {
  it("201 fresh insert yields the id", () => {
    expect(interpretDoorReply(201, { id: ID, state: "pending" })).toEqual({ id: ID });
  });

  it("200 live replay yields the SAME id (duplicate:true)", () => {
    expect(interpretDoorReply(200, { id: ID, state: "pending", duplicate: true })).toEqual({
      id: ID,
    });
  });

  // mutation: make the 409 branch throw (delete the `status === 409` arm so it falls into
  //           the reject path) -> red. RUN ✅ 2026-08-12
  //   DoorReplyError: door replied 409 and the ask was NOT queued: idempotency key already
  //   reached a TERMINAL state
  //     ❯ interpretDoorReply src/door-reply.ts:64  ❯ test/door-reply.test.ts:38
  //   restored -> 9 passed.
  it("409 TERMINAL replay yields the id — it does NOT throw", () => {
    expect(
      interpretDoorReply(409, {
        error: "idempotency key already reached a TERMINAL state",
        id: ID,
        state: "rejected",
        duplicate: true,
        terminal: true,
      }),
    ).toEqual({ id: ID });
  });
});

describe("interpretDoorReply — and only the id-less replies reject", () => {
  it("422 fingerprint mismatch rejects", () => {
    expect(() =>
      interpretDoorReply(422, { error: "idempotency key reused with a DIFFERENT ask" }),
    ).toThrow(DoorReplyError);
  });

  it("429 cap/rate rejects", () => {
    expect(() => interpretDoorReply(429, { error: "queue is at cap" })).toThrow(DoorReplyError);
  });

  it("503 not-recorded rejects (the door's own catch carries no id)", () => {
    expect(() => interpretDoorReply(503, { error: "proposal was NOT recorded" })).toThrow(
      DoorReplyError,
    );
  });

  it("401 rejects", () => {
    expect(() => interpretDoorReply(401, {})).toThrow(DoorReplyError);
  });

  // The defensive case the door's own contract forbids: a 2xx/409 with no id is a broken
  // door, and a caller must NOT invent one.
  it("an id-bearing status with NO id rejects rather than returning undefined", () => {
    expect(() => interpretDoorReply(201, { state: "pending" })).toThrow(DoorReplyError);
    expect(() => interpretDoorReply(409, { terminal: true })).toThrow(DoorReplyError);
  });

  it("the error carries the status and the door's own detail, so a loop is diagnosable", () => {
    try {
      interpretDoorReply(422, { error: "idempotency key reused with a DIFFERENT ask" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DoorReplyError);
      expect((err as DoorReplyError).status).toBe(422);
      expect((err as DoorReplyError).message).toContain("DIFFERENT ask");
    }
  });
});
