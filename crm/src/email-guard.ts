// Email spike — the last thing between an approved payload and a real inbox.
//
// PURE, SYNCHRONOUS, NO I/O, NO CLOCK, NO `process.env`. Three reasons, all deliberate:
// every case is a table row rather than a fixture; the no-timer pin has a small surface to
// measure; and the allowlist arrives as an ARGUMENT, so no test and no future caller can
// accidentally depend on ambient environment for the one decision that reaches a human.
//
// 🚨 FAIL CLOSED. Unset, empty, and whitespace-only allowlists refuse EVERYTHING. The
// failure mode of a misconfigured allowlist must be "nothing was sent", never "it was sent
// to whoever happened to be in the payload".
//
// 🚨 NOTHING HERE TRANSFORMS THE PAYLOAD. It answers yes or no. The value that was approved,
// hashed and rendered is the value that gets sent, byte for byte — see
// `approval/src/proposal.ts`'s `followUpEmailPayloadSchema` for the other half of that
// property.

export interface SendableCandidate {
  to?: unknown;
  subject?: unknown;
  body?: unknown;
  [k: string]: unknown;
}

export type SendableResult = { ok: true } | { ok: false; reason: string };

/** Template syntax that survived rendering. `{{name}}`, `{{ name }}` and `{name}` all mean
 *  the same thing to the human who receives it: a machine wrote this and nobody read it. */
const PLACEHOLDER = /\{\{\s*[\w.]+\s*\}\}|\{\s*[\w.]+\s*\}/;

/** Stringified nothing. A message containing either of these is a bug wearing a message's
 *  clothes, and it is about to be sent to a prospect under the operator's name. */
const STRINGIFIED_NOTHING = /\bundefined\b|\[object Object\]/;

/** 🚨 THE HEADER-INJECTION VECTOR. A `\r` or `\n` in a header-bound field is how a mail
 *  send reaches a person nobody approved (`"Following up\r\nBcc: stranger@example.com"`).
 *  Nodemailer MIME-encodes subjects, so exploitation is unlikely — but relying on an
 *  undocumented vendor behaviour for the single attack that mails a stranger is precisely
 *  the dependency the allowlist exists to remove. Checked on `body` too; it costs nothing. */
const CRLF = /[\r\n]/;

const TEXT_FIELDS = ["to", "subject", "body"] as const;

/**
 * May this payload be handed to a transport?
 *
 * @param payload   the parsed, approved payload — NOT modified
 * @param allowlist the recipients this deployment may reach. INJECTED, never read from
 *                  `process.env` here. Empty or whitespace-only means refuse everything.
 */
export function checkSendable(
  payload: SendableCandidate,
  allowlist: readonly string[],
): SendableResult {
  // 1. Every text field must be a present, non-empty string. An `undefined`-VALUED key is
  //    refused explicitly: `render.ts:147`'s `in` guard lets such a key reach the card,
  //    where it renders as the literal `null`, so the human approved a description of the
  //    message that the message does not match.
  for (const field of TEXT_FIELDS) {
    const v = payload[field];
    if (v === undefined) return { ok: false, reason: `${field} is undefined` };
    if (v === null) return { ok: false, reason: `${field} is null` };
    if (typeof v !== "string") return { ok: false, reason: `${field} is not a string` };
    if (v.length === 0) return { ok: false, reason: `${field} is empty` };
  }

  const to = payload.to as string;
  const subject = payload.subject as string;
  const body = payload.body as string;

  // 2. Header injection, before anything else looks at the content.
  for (const [field, v] of [
    ["to", to],
    ["subject", subject],
    ["body", body],
  ] as const) {
    if (CRLF.test(v)) {
      return { ok: false, reason: `${field} contains a carriage return or newline` };
    }
  }

  // 3. Unrendered templates and stringified nothing, in the fields a human will read.
  for (const [field, v] of [
    ["subject", subject],
    ["body", body],
  ] as const) {
    if (PLACEHOLDER.test(v)) {
      return { ok: false, reason: `${field} contains an unrendered template placeholder` };
    }
    if (STRINGIFIED_NOTHING.test(v)) {
      return { ok: false, reason: `${field} contains stringified nothing` };
    }
  }

  // 4. The allowlist. Exact match on the FULL address, case-insensitive.
  //    🚨 NO DOMAIN WILDCARDS — a wildcard is how an allowlist stops being one.
  const permitted = allowlist
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.length > 0);
  if (permitted.length === 0) {
    return {
      ok: false,
      reason:
        "the recipient allowlist is empty, so no recipient is permitted (fail-closed): " +
        "set SWITCHBOARD_EMAIL_ALLOWLIST",
    };
  }
  if (!permitted.includes(to.toLowerCase())) {
    return { ok: false, reason: `recipient ${to} is not on the allowlist` };
  }

  return { ok: true };
}
