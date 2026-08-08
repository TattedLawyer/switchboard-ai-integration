// Phase 3 / A2 — how a proposal is put in front of the human who decides.
//
// 🚨 WHAT A2 DOES NOT ATTEST. Read this before adding anything to this file.
//
//   A2 does NOT attest what her browser painted. It attests that the PAYLOAD SHE APPROVED
//   CANNOT CHANGE (the column grant and the trigger in migration 015), and that we
//   recorded, AS AUDIT METADATA ONLY, which renderer version showed it to her. It does not
//   attest anything about the rendering at execution time — A2 executes against ANY
//   rendering whatsoever. And it does not bind the payload to the SMTP envelope:
//   everything between the canonical payload and what the recipient receives is built by
//   C5 and is OUTSIDE anything A2 guarantees.
//
// Three claims are permanently banned here, each of which shipped once as a published
// guarantee with no mechanism behind it:
//   1. "what you approved is the screen you were shown, byte for byte" — or ANY claim
//      about what her browser rendered. The mechanism that once carried it hashed bytes
//      the SERVER produced and compared them against a server-side re-render of the same
//      immutable row: both sides our own pure function of one input, so it detected only
//      our own renderer nondeterminism. A proxied client, a browser extension, a CSS rule
//      or a stale bundle posts back a correct hash of bytes it never displayed.
//   2. "we will not execute against a rendering we no longer produce" — the
//      `renderer_version` runtime check. Deleted: no nameable threat (the payload is
//      immutable and the approval is attributable regardless of what rendered it) and a
//      concrete cost (after any renderer deploy, every approved-but-unexecuted proposal
//      would refuse execution permanently).
//   3. anything that makes `renderer_version` a PREDICATE. It is recorded and it is never
//      read in the request path.
//
// WHAT SURVIVES IS A CI PROPERTY, NOT A RUNTIME GUARD: the payload region of a card must
// render byte-identically across processes, time zones, locales and clocks. That is a
// determinism check, and a determinism check belongs in the test suite.
//
// THE RENDERING RULES, and each one's source:
//   · EVERYTHING DECISION-RELEVANT ON THE CARD FACE, NO EXPANDER. Measured: detail links
//     drew 1.6% (Chrome "Help me understand"), 0% (Firefox "Technical Details"), 3%
//     ("View Certificate"). A detail nobody opens is a detail nobody saw.
//   · CARDS DIFFERENTIATE BY ACTION TYPE AND MATERIALITY ON THEIR FACE. Firefox's "Add
//     Exception" showed 85.4% confirmation barely varying by error type — users "ignore
//     the categories" when the categories are not on the face.
//   · NO CONFIRMATION FRICTION. Added clicks did not deter: 84% proceeded through the
//     extra dialog. (The source's own hedge kept: "no evidence it helps at low friction",
//     not "proven useless".)
//   · NO BULK APPROVE, EVER. A request for one is evidence that an action type needs
//     narrowing, not evidence that the UI needs a checkbox.
//   · THE DISPLAY MAP MAY ORDER AND LABEL. IT MAY NOT OMIT.
import { PROPOSAL_ACTION_TYPES, type ProposalActionType } from "./proposal.js";

/**
 * AUDIT METADATA ONLY. Recorded on every decision row so A3's log can say which code
 * showed a proposal to a human. 🚨 NEVER A PREDICATE — nothing in the request path may
 * compare it, and an unused column with an obvious comparison available is precisely the
 * re-entry point a rejected design would come back through.
 */
export const RENDERER_VERSION = "a2.1";

/**
 * The display map: which payload keys get a human label, and in what order.
 *
 * 🚨 IT MAY ORDER AND LABEL. IT MAY NOT OMIT. Any key present in the payload and absent
 * from this map falls into a trailing "additional fields" block — it is never dropped. A
 * dropped field is a field the human approved and the executor acts on unseen, which is
 * the same defect class as a silently discarded proposal.
 */
const DISPLAY_MAP: Record<ProposalActionType, { key: string; label: string }[]> = {
  send_email: [
    { key: "to", label: "To" },
    { key: "cc", label: "Cc" },
    { key: "subject", label: "Subject" },
    { key: "body", label: "Message" },
  ],
};

/** The one-line description of what this action DOES, on the card's face. */
const ACTION_HEADLINE: Record<ProposalActionType, string> = {
  send_email: "Send an email on your behalf",
};

/** HTML escaping — the real thing, for the real output context.
 *
 *  🚨 `fenceUntrusted` (agent/src/host/report.ts) IS THE WRONG FUNCTION HERE. It is a
 *  MARKDOWN fence; this surface is HTML. It does not escape `&`, it mishandles attribute
 *  contexts, and it strips characters that are harmless in HTML while leaving the real
 *  escaping undone. The doctrine transfers; the function does not. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render one payload value.
 *
 * 🚨 NOTHING LOCALE-DEPENDENT, TIME-DEPENDENT OR ENVIRONMENT-DEPENDENT MAY ENTER THIS
 * FUNCTION. No `toLocaleString`, no `Intl`, no `Date` formatting, no `process.env`. The
 * payload region has to be byte-identical across processes, time zones, locales and
 * clocks, and that property is pinned by a cross-process test. If you need to format a
 * date for the human, do it OUTSIDE the payload region.
 */
function renderValue(value: unknown): string {
  if (typeof value === "string") return escapeHtml(value);
  if (value === null) return "<em>(empty)</em>";
  if (typeof value === "number" || typeof value === "boolean") return escapeHtml(String(value));
  // Objects and arrays are shown, not summarised: "3 items" is an expander by another
  // name. Keys are sorted so the bytes do not depend on insertion order.
  return `<code>${escapeHtml(stableJson(value))}</code>`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * THE PAYLOAD REGION — the bytes the determinism pin covers.
 *
 * Every key present in the payload appears exactly once: mapped keys first, in the map's
 * order, then everything else in sorted order under "Additional fields".
 */
export function renderPayloadRegion(
  actionType: string,
  payload: Record<string, unknown>,
): string {
  const map = isKnownAction(actionType) ? DISPLAY_MAP[actionType] : [];
  const mappedKeys = new Set(map.map((m) => m.key));
  const rows: string[] = [];

  for (const { key, label } of map) {
    if (!(key in payload)) continue; // absent is absent; it is not rendered as empty
    rows.push(
      `<div class="field"><span class="label">${escapeHtml(label)}</span>` +
        `<span class="value">${renderValue(payload[key])}</span></div>`,
    );
  }

  // THE NO-OMISSION CLAUSE. Anything the map did not name still renders — labelled with
  // its raw key, because inventing a label for a field we did not design would be a worse
  // lie than showing the key.
  const extras = Object.keys(payload)
    .filter((k) => !mappedKeys.has(k))
    .sort();
  if (extras.length > 0) {
    rows.push('<div class="additional"><span class="label">Additional fields</span>');
    for (const key of extras) {
      rows.push(
        `<div class="field"><span class="label">${escapeHtml(key)}</span>` +
          `<span class="value">${renderValue(payload[key])}</span></div>`,
      );
    }
    rows.push("</div>");
  }

  return `<div class="payload">${rows.join("")}</div>`;
}

function isKnownAction(t: string): t is ProposalActionType {
  return (PROPOSAL_ACTION_TYPES as readonly string[]).includes(t);
}

export interface CardRow {
  id: string;
  action_type: string;
  payload: Record<string, unknown>;
  rationale: string;
  /** Rendered outside the payload region, and deliberately as an ISO instant rather than
   *  a localised string — a countdown or a formatted local time is not a pure function of
   *  the row, and putting one in the payload region is how the determinism pin reds. */
  expires_at: string;
  duplicates?: number;
}

/**
 * The whole card. One proposal, one externally-visible outcome, everything on the face.
 *
 * THE RATIONALE BLOCK IS AN INJECTION SURFACE AND IS TREATED AS ONE. It is model-authored
 * prose rendered into the decision surface of the accountable human, and an instruction
 * injected there only has to fool a PERSON, not a model. So it is rendered inertly: inside
 * a fixed, visually distinct block, escaped for its actual output context, captioned with
 * text THE MODEL NEVER AUTHORED, and never styleable as system chrome. The caption is a
 * constant in this file for exactly that reason — if it could come from the row, the
 * attacker would write it.
 */
export const RATIONALE_CAPTION = "The agent's stated reason. This is not a verification.";

export function renderProposalCard(row: CardRow): string {
  const headline = isKnownAction(row.action_type)
    ? ACTION_HEADLINE[row.action_type]
    : `Perform an action of type "${escapeHtml(row.action_type)}"`;

  return [
    `<article class="proposal" data-proposal-id="${escapeHtml(row.id)}"`,
    ` data-renderer-version="${escapeHtml(RENDERER_VERSION)}">`,
    // MATERIALITY AND ACTION TYPE ON THE FACE — users ignore categories that are not there.
    `<h2 class="headline">${escapeHtml(headline)}</h2>`,
    renderPayloadRegion(row.action_type, row.payload),
    // The block, the caption, then the untrusted prose — in that order, so the caption can
    // never be mistaken for part of what the agent wrote.
    '<section class="rationale">',
    `<p class="rationale-caption">${escapeHtml(RATIONALE_CAPTION)}</p>`,
    `<blockquote class="rationale-text">${escapeHtml(row.rationale)}</blockquote>`,
    "</section>",
    // Outside the payload region on purpose: an instant, not a countdown or a local time.
    `<p class="expiry">Expires <time datetime="${escapeHtml(row.expires_at)}">${escapeHtml(row.expires_at)}</time></p>`,
    row.duplicates && row.duplicates > 0
      ? `<p class="duplicates">${row.duplicates} identical repeat(s) collapsed into this card</p>`
      : "",
    // Three outcomes, and no bulk anything. "Not now" writes a decision row and leaves the
    // proposal pending; passive navigation records nothing, because we cannot tell
    // "considered it and walked away" from "closed the laptop" and recording the second as
    // the first manufactures evidence about a human's state of mind.
    '<div class="decide">',
    '<button name="decision" value="approved">Approve</button>',
    '<button name="decision" value="rejected">Reject</button>',
    '<button name="decision" value="dismissed">Not now</button>',
    "</div>",
    "</article>",
  ].join("");
}
