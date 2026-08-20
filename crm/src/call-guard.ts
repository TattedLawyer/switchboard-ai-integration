// Call allowlist — the last thing between an approved payload and a real telephone.
//
// The call twin of `email-guard.ts`, and deliberately the SAME doctrine, stated once there
// and mirrored here rather than reinvented: two channels with different rules for the same
// problem is a bug class, not a design.
//
// PURE, SYNCHRONOUS, NO I/O, NO CLOCK, NO `process.env`. The allowlist arrives as an
// ARGUMENT, so no test and no future caller can accidentally widen it by depending on
// ambient environment for the one decision that makes a stranger's phone ring.
//
// 🚨 FAIL CLOSED. Unset, empty, and whitespace-only allowlists refuse EVERYTHING. The
// failure mode of a misconfigured allowlist must be "nobody's phone rang", never "it
// dialled whoever happened to be in the payload".
//
// 🚨 NOTHING HERE TRANSFORMS THE NUMBER. It answers yes or no. The E.164 string that was
// approved, hashed and rendered on the card is the string that is compared, byte for byte
// — `placeCallPayloadSchema` owns the grammar, one level up, and this module never tidies
// a payload value into a match.
//
// CHECKED IN TWO PLACES, mirroring email exactly:
//   · `executeCall` (`executor.ts`) — BEFORE `beginExecution`, so a refusal burns no
//     execution row and the proposal stays `approved` for a later, correctly-configured
//     tick;
//   · `livekitPlaceCall` (`call-transport.ts`) — immediately before the dial, so even a
//     caller that bypasses the executor cannot dial an unlisted number. The fail-closed
//     property belongs to the thing that reaches the vendor, not to one call site
//     (email-spike review I5, applied to calls).

/** The one place the allowlist string becomes a list.
 *
 *  🚨 A MALFORMED ENTRY THROWS. A typo must be a STARTUP FAILURE, never a silently-
 *  shortened list: a silently-shortened list is a fail-closed guard quietly refusing the
 *  one number the operator meant to permit, and the operator's next move is to widen the
 *  config until something finally dials. Loud beats subtle here.
 *
 *  Unset, empty and whitespace-only all yield the frozen `[]` — which `checkCallable`
 *  refuses everything against. That is the intended reading of "no allowlist configured".
 *
 *  Called at the CLI edge only. `process.env` is never read inside this module or inside
 *  the executor; the resulting list is passed in as an argument — and it is FROZEN, so
 *  nothing downstream can append to it. */
export function parsePhoneAllowlist(raw: string | undefined): readonly string[] {
  if (raw === undefined) return Object.freeze([]);
  if (raw.trim().length === 0) return Object.freeze([]);

  const out: string[] = [];
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (entry.length === 0) {
      // An empty ELEMENT is a typo ("+63…,,+63…" — somebody deleted an entry badly), not
      // an absence. Refused, not dropped.
      throw new Error(
        `SWITCHBOARD_PHONE_ALLOWLIST has an empty entry: ${JSON.stringify(raw)}`,
      );
    }
    if (!ALLOWLIST_ENTRY.test(entry)) {
      throw new Error(
        `SWITCHBOARD_PHONE_ALLOWLIST entry is not an E.164 number ` +
          `(+ then up to 15 digits, e.g. +639171234567): ${JSON.stringify(part)}`,
      );
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return Object.freeze(out);
}

/** E.164 and nothing looser: a leading `+`, a non-zero first digit, at most 15 digits in
 *  all. Deliberately shape-only — validity and type are properties this repo refuses to
 *  store or guess (`phone.ts`'s FALSEHOODS stance); the allowlist is a LIST OF PERMITTED
 *  STRINGS, compared exactly, and this pattern exists so a national-format or
 *  spaces-and-dashes entry dies at startup instead of silently matching nothing forever.
 *  Exported for ONE consumer: `livekitPlaceCall`'s construction-time validation of an
 *  injected list, so the transport and the parser cannot drift apart on what an entry is. */
export const E164_EXACT = /^\+[1-9]\d{1,14}$/;
const ALLOWLIST_ENTRY = E164_EXACT;

export type CallableResult = { ok: true } | { ok: false; reason: string };

/**
 * May this number be dialled?
 *
 * @param phoneE164 the payload's `phone_e164`, verbatim — NOT modified, NOT trimmed
 * @param allowlist the numbers this deployment may dial. INJECTED, never read from
 *                  `process.env` here. Empty or whitespace-only means refuse everything.
 *
 * 🚨 EXACT MATCH ONLY on the full E.164 string. NO prefix matching, NO wildcards, NO
 * country-level allow — a prefix is how an allowlist stops being one (the same judgment
 * that refuses domain wildcards in `email-guard.ts`).
 */
export function checkCallable(
  phoneE164: unknown,
  allowlist: readonly string[],
): CallableResult {
  if (phoneE164 === undefined) return { ok: false, reason: "phone_e164 is undefined" };
  if (phoneE164 === null) return { ok: false, reason: "phone_e164 is null" };
  if (typeof phoneE164 !== "string") {
    return { ok: false, reason: "phone_e164 is not a string" };
  }
  if (phoneE164.length === 0) return { ok: false, reason: "phone_e164 is empty" };

  // Entries are tidied DEFENSIVELY (an injected list may carry stray whitespace); the
  // payload value never is — the approved bytes are the compared bytes.
  const permitted = allowlist.map((n) => n.trim()).filter((n) => n.length > 0);
  if (permitted.length === 0) {
    return {
      ok: false,
      reason:
        "the phone allowlist is empty, so no number may be dialled (fail-closed): " +
        "set SWITCHBOARD_PHONE_ALLOWLIST",
    };
  }
  if (!permitted.includes(phoneE164)) {
    return { ok: false, reason: `number ${phoneE164} is not on the phone allowlist` };
  }

  return { ok: true };
}
