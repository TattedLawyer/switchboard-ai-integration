// Family 3 / review I-2 — the crm→door reply contract, isolated as a PURE function so the
// adapter that eventually speaks HTTP has a tested core it cannot silently get wrong.
//
// 🚨 THIS SHIPS NO HTTP CLIENT AND WIRES NOTHING. The production `crm→door` adapter does not
// exist; the proposer still takes `postProposal` as an injected seam. What is fixed here is
// the one decision Family 3's heal depends on.
//
// 🚨 THREE STATUSES CARRY THE AUTHORITATIVE ID, NOT TWO.
//   · 201 — fresh insert                       (`approval/src/server.ts:354`)
//   · 200 — live replay, `duplicate: true`     (`approval/src/server.ts:91`)
//   · 409 — TERMINAL replay, `duplicate: true, terminal: true`, id in the body
//           (`approval/src/server.ts:78-90`, id at `:84`)
// The door's unique index is permanent and state-blind, so once an ask has been rejected,
// expired, superseded, executed or failed, the SAME key replays as 409 for ever. Family 3
// freezes that key deliberately: the cross-midnight retry re-POSTs it and MUST come away
// with the id, because the action row is what lets the close pass see the disposal
// (`crm/src/reconcile.ts` joins through `crm.follow_up_actions.proposal_id`).
//
// 🚨 DO NOT COPY `agent/src/host/propose.ts:147-154`. That sibling client throws on any
// non-2xx and drops the id. In the CRM loop that turns a human REJECTION — the single most
// ordinary event in an approve/reject system — into a per-cycle throw loop against a
// zero-action orphan the close pass can never see: permanent silence, the exact class this
// whole family exists to close. A 409 is not an error here; it is an answer.

/** A door reply that carries no usable id. Never swallowed, never turned into a fake id. */
export class DoorReplyError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DoorReplyError";
    this.status = status;
  }
}

const detailOf = (body: unknown): string => {
  if (typeof body !== "object" || body === null) return "";
  const b = body as Record<string, unknown>;
  const parts = [b.error, b.detail].filter((x): x is string => typeof x === "string");
  return parts.join(" — ");
};

const idOf = (body: unknown): string | null => {
  if (typeof body !== "object" || body === null) return null;
  const id = (body as Record<string, unknown>).id;
  return typeof id === "string" && id !== "" ? id : null;
};

/**
 * Interpret one door reply. Resolves `{id}` for 201 / 200 / 409-terminal; throws
 * `DoorReplyError` for everything else — 422 fingerprint mismatch, 429 cap or rate, 5xx, and
 * any auth/transport status. Also throws when an id-bearing status arrives WITHOUT an id: a
 * door that breaks its own contract must stop the caller, not hand it `undefined`.
 */
export function interpretDoorReply(status: number, body: unknown): { id: string } {
  if (status === 201 || status === 200 || status === 409) {
    const id = idOf(body);
    if (id !== null) return { id };
    throw new DoorReplyError(
      status,
      `door replied ${status} without an id — the reply contract is broken, nothing may be ` +
        `recorded against it${detailOf(body) ? `: ${detailOf(body)}` : ""}`,
    );
  }
  throw new DoorReplyError(
    status,
    `door replied ${status} and the ask was NOT queued${
      detailOf(body) ? `: ${detailOf(body)}` : ""
    }`,
  );
}
