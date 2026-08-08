// Phase 3 / A2, T1 — canonical serialisation and the payload hash.
//
// `payload_hash` has EXACTLY ONE JOB (plan §3.1): idempotency-collision detection at the
// door — distinguishing a retry of the same call from a different proposal reusing a key.
// It is not a TOCTOU control, not a display binding, and is never described as either.
// Payload integrity is held by privilege and by a trigger (§3.2), not by this hash.
//
// The pins here, and what each one varies — because a self-comparison that varies nothing
// is the defect this plan was rejected for three times (§4, the shape-1 exception):
//
//   · KEY ORDER — two DIFFERENT inputs through one function, asserted equal. The
//     independent variable is the input. Removing `sortDeep` flips it.
//   · ROUND TRIP — one input through TWO different custody paths (in-process object vs.
//     the same object after a real INSERT ... RETURNING through jsonb and the driver's
//     parser). The independent variable is the storage round trip. Its purpose is to
//     prove the equivalence §3.1 asserts — that the stored bytes are the hashed bytes —
//     NOT to distinguish two hashing sites, which it measurably cannot.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash } from "node:crypto";
import { freshTestDb } from "../../ingest/test/helpers/testdb.js";
import { canonicalStringify, payloadHash } from "../src/canonical.js";

const TENANT = "00000000-0000-0000-0000-000000000000";

let admin: pg.Pool;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const r = await freshTestDb();
  admin = r.pool;
  cleanup = r.cleanup;
}, 60_000);

afterAll(async () => {
  if (cleanup) await cleanup();
});

/** The adversarial payload set. Every entry is a shape that has broken a serialiser
 *  somewhere: key order and nesting, the exponent boundary `1e21`, a plain decimal,
 *  integer precision loss beside `-0`, escapes and non-ASCII, empty containers,
 *  astral-plane code points, float associativity, a denormal, and the float maximum. */
const ADVERSARIAL: { name: string; payload: Record<string, unknown> }[] = [
  { name: "key order and nesting", payload: { b: 1, a: { d: 4, c: [3, { f: 6, e: 5 }] } } },
  { name: "1e21 — the exponent-notation boundary", payload: { n: 1e21 } },
  { name: "1.5 — a plain decimal", payload: { n: 1.5 } },
  { name: "precision loss beside -0", payload: { big: 12345678901234567890, neg: -0 } },
  { name: "escapes and non-ASCII", payload: { s: 'a"b\\c\nd\teéf' } },
  { name: "empty containers", payload: { o: {}, a: [], s: "" } },
  { name: "astral plane", payload: { s: "\u{1F600}\u{10FFFF}" } },
  { name: "float associativity 0.1+0.2", payload: { n: 0.1 + 0.2 } },
  { name: "denormal 1e-320", payload: { n: 1e-320 } },
  { name: "Number.MAX_VALUE", payload: { n: Number.MAX_VALUE } },
];

describe("A2/T1: canonical serialisation", () => {
  it("is key-order independent — two different inputs, one output", () => {
    // mutation: remove `sortDeep` from `canonicalStringify` -> red. RUN ✅ 2026-08-08
    expect(canonicalStringify({ b: 1, a: 2 })).toBe(canonicalStringify({ a: 2, b: 1 }));
    expect(payloadHash({ b: 1, a: 2 })).toBe(payloadHash({ a: 2, b: 1 }));
  });

  it("sorts keys at every depth, inside arrays included", () => {
    // mutation: make `sortDeep` shallow (stop recursing into objects/arrays) -> red.
    // RUN ✅ 2026-08-08
    const one = { z: { y: 1, x: 2 }, a: [{ q: 1, p: 2 }] };
    const two = { a: [{ p: 2, q: 1 }], z: { x: 2, y: 1 } };
    expect(canonicalStringify(one)).toBe(canonicalStringify(two));
    expect(canonicalStringify(one)).toBe('{"a":[{"p":2,"q":1}],"z":{"x":2,"y":1}}');
  });

  it("payloadHash is the FULL 64-hex sha256 of the canonical bytes — never truncated", () => {
    // The ingest sibling truncates to 16 hex because its collision domain is one row's
    // content history. This one's domain is every payload ever proposed under a tenant,
    // and it decides whether a retry is the same call — so it keeps all 256 bits.
    const p = { to: "jane@client.example.com", subject: "renewal" };
    const h = payloadHash(p);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(createHash("sha256").update(canonicalStringify(p)).digest("hex"));
  });

  it("is byte-identical to the ingest connector's serialiser for shapes both accept", async () => {
    // V15: the cross-workspace idiom is DELIBERATE DUPLICATION with a keep-in-sync
    // comment, never a cross-import. This pin is what makes "keep in sync" checkable.
    const { canonicalStringify: ingestStringify } = await import(
      "../../ingest/src/connectors/sheet-canonical.js"
    );
    for (const { name, payload } of ADVERSARIAL) {
      expect(canonicalStringify(payload), name).toBe(ingestStringify(payload));
    }
  });

  describe("the round trip through jsonb — the stored bytes ARE the hashed bytes", () => {
    it("canonicalises identically before and after a real INSERT ... RETURNING payload", async () => {
      // mutation A: pg.types.setTypeParser(3802, x => x)  (driver jsonb parser -> identity)
      //             -> red. RUN ✅ 2026-08-08
      // mutation B: approval.proposals.payload column type jsonb -> text
      //             -> red. RUN ✅ 2026-08-08
      //
      // §3.1: the door hashes the value returned by `insert ... returning payload`, so the
      // stored bytes are definitionally the hashed bytes. This pin is the evidence for
      // that sentence. It varies the CUSTODY PATH, not the function.
      for (const [i, { name, payload }] of ADVERSARIAL.entries()) {
        const ins = await admin.query(
          `insert into approval.proposals
             (tenant_id, idempotency_key, action_type, payload, rationale,
              payload_hash, expires_at)
           values ($1, $2, 'send_email', $3::jsonb, 'round-trip pin', $4,
                   now() + interval '72 hours')
           returning payload`,
          [TENANT, `t1-roundtrip-${i}`, canonicalStringify(payload), payloadHash(payload)],
        );
        const returned = ins.rows[0].payload as unknown;
        expect(canonicalStringify(returned), name).toBe(canonicalStringify(payload));
        expect(payloadHash(returned as Record<string, unknown>), name).toBe(payloadHash(payload));
      }
    });
  });
});
