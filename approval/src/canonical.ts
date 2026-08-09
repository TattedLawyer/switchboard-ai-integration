// Phase 3 / A2 — canonical serialisation and the proposal payload hash.
//
// KEEP IN SYNC with `ingest/src/connectors/sheet-canonical.ts:116-136`. This is the repo's
// established cross-workspace idiom (V15, and `mocks/core/src/ledger.ts:7-9` before it):
// DELIBERATE DUPLICATION with a keep-in-sync comment, never a cross-import. The two
// workspaces ship independently and neither may take a build dependency on the other, so
// the honest form is a copy plus a test that compares them byte for byte
// (`approval/test/canonical.test.ts`, "byte-identical to the ingest connector's
// serialiser"). If you change `sortDeep` here, change it there, and that pin will tell
// you if you did not.
//
// ONE DELIBERATE DIVERGENCE: the ingest sibling truncates its digest to 16 hex chars,
// because its collision domain is one row key's own content history. This one's domain is
// every payload ever proposed under a tenant, and it decides whether a retried call is the
// SAME call — so it keeps the full 64 hex.
//
// WHAT THIS HASH IS FOR, and the sentence that must not grow (plan §3.1): idempotency-
// collision detection AT THE DOOR ONLY — telling a retry of the same call apart from a
// different proposal reusing a key. It is NOT a TOCTOU control, NOT a display binding, and
// NOT what makes the payload immutable. Immutability is held by a column grant and a
// BEFORE UPDATE trigger (§3.2). Three revisions of this plan were rejected for describing
// a hash as a binding it was not; do not restore that description here.
import { createHash } from "node:crypto";

/** Deterministic deep-key-sorted JSON — the canonical serialisation. */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * The full 64-hex sha256 over the canonical bytes of a proposal payload.
 *
 * WHICH BYTES ARE AUTHORITATIVE (§3.1): the door hashes the value returned by
 * `insert ... returning payload`, so the stored bytes are definitionally the hashed bytes
 * and no jsonb-normalisation question arises. A NUL byte in a payload string makes that
 * INSERT throw — a 503, not a divergence, and the correct outcome.
 */
export function payloadHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalStringify(payload)).digest("hex");
}

/** The marker written for rows that predate `payload_hash` (T2's legacy backfill). A
 *  constraint forbids approving a row carrying it: we cannot attest a payload we never
 *  hashed. Deliberately not a valid hex digest, so it can never collide with a real one. */
export const LEGACY_UNHASHABLE = "legacy:unhashable";

/**
 * THE PUBLISHED IDEMPOTENCY FINGERPRINT — `(action_type, payload_hash, rationale)`.
 *
 * 🚨 WHAT THIS FIXES. The door used to compare ONLY `payload_hash` when resolving a reused
 * key. Measured: same key, same payload, `rationale` changed from "routine follow-up" to
 * "client called; she is threatening to list elsewhere" -> `200 {duplicate:true}`, nothing
 * written, stored rationale unchanged. That is exactly the silent first-write-wins the 422
 * branch was introduced to eliminate, on the one field a human reads to decide.
 *
 * WHY A NAMED SUBSET RATHER THAN "COMPARE EVERYTHING". Comparing a subset is explicitly
 * sanctioned — the IETF idempotency-key draft §2.4 lists "Checksum of selected element(s)
 * in the request payload" as a fingerprint algorithm. The defect was never that the subset
 * was partial; it was that the subset was UNDOCUMENTED and SILENTLY LOSSY. AWS shows the
 * defensible shape: it NAMES its two exempted fields in public documentation and errors on
 * everything else (`IdempotentParameterMismatch`). So this fingerprint is declared here,
 * returned in the 422 body, documented in the RUNBOOK, and pinned by a test — so adding a
 * field to the proposal grammar forces a decision instead of defaulting to
 * silently-ignored.
 *
 * It is deliberately the SAME triple as `suppress.ts`'s suppression key. The door and the
 * suppressor disagreeing about what makes two asks "the same" is what produced this defect.
 *
 * NOT the raw request bytes: `payload_hash` is computed over a canonical serialisation, and
 * hashing the literal body would turn trivial reserialisation differences into 422s.
 */
export const IDEMPOTENCY_FINGERPRINT_FIELDS = [
  "action_type",
  "payload_hash",
  "rationale",
] as const;

export interface Fingerprintable {
  action_type: string;
  payload_hash: string;
  rationale: string;
}

export function idempotencyFingerprint(row: Fingerprintable): string {
  return canonicalStringify([row.action_type, row.payload_hash, row.rationale]);
}
