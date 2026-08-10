// Core loop / T12 — how a call ends, and the one conflation this file exists to prevent.
//
// 🚨 TWO INDEPENDENT INPUTS.
//   · THE TRANSPORT answers "did anything pick up?" — `{ sipStatus, amdResult }`.
//   · THE CONVERSATION answers "was it her prospect?" — known only from the identity check
//     the agent performs in its opening line.
//
// `wrong_person` is a CONVERSATIONAL outcome that arrives on a perfectly healthy SIP call.
// Deriving it from the transport is impossible, and deriving `answered` from the transport
// is the bug: `answered` ALONE NEVER MEANS SUCCESS. Success is contact reached AND identity
// confirmed AND questionnaire progressed, which is why `wrong_person` cannot be a flavour
// of `answered` and why a 200 OK on its own resolves to `unknown_answer`.
//
// 🚨 THE OUTCOME SET IS NOT UNIFORM ACROSS BOTH CALL PATHS. `wrong_person` is UNREACHABLE
// for a nameless contact: there is no name to ask for, so no identity question is asked and
// no determination is made. Those calls carry `identity_unverified = true` alongside an
// ordinary disposition instead, and 016's CHECK makes the combination unrepresentable
// rather than merely unlikely.
import type { Disposition } from "./touch.js";

export type AmdResult = "human" | "machine" | "unknown" | null | undefined;

export interface TransportSignal {
  sipStatus: number;
  amdResult?: AmdResult;
}

export type TransportOutcome =
  | { kind: "settled"; disposition: Disposition }
  | { kind: "conversation" };

/**
 * What the transport alone can conclude.
 *
 * 🚨 SOURCED (LiveKit): "Voicemail systems answer the call at the SIP layer with a 200 OK."
 * Mapping on SIP status alone therefore marks every voicemail `answered` — and a machine
 * that picked up would buy the prospect a full follow-up interval of silence.
 *
 * 🚨 AMD RELIABILITY ON PHILIPPINE CARRIERS IS UNKNOWN. `unknown_answer` exists because of
 * that: an absent or inconclusive AMD result is NOT evidence of a human, and defaulting it
 * to `answered` would launder ignorance into a successful contact.
 */
export function mapTransport(t: TransportSignal): TransportOutcome {
  switch (t.sipStatus) {
    case 486:
      return { kind: "settled", disposition: "busy" };
    case 603:
      return { kind: "settled", disposition: "declined" };
    case 408:
    case 480:
      return { kind: "settled", disposition: "no_answer" };
    case 200:
      if (t.amdResult === "machine") return { kind: "settled", disposition: "voicemail" };
      if (t.amdResult === "human") return { kind: "conversation" };
      return { kind: "settled", disposition: "unknown_answer" };
    default:
      // Never connected. Collapsing 486/603/408/480 here too would throw away the only
      // information those codes carry.
      return { kind: "settled", disposition: "failed" };
  }
}

/** What the agent learned from the person who answered. */
export type ConversationOutcome =
  | "identity_confirmed_complete"
  | "identity_confirmed_cut_off"
  | "not_the_contact"
  /** The nameless path: nobody was asked, so nobody was ruled out. */
  | "identity_not_asked_complete"
  | "identity_not_asked_cut_off";

export interface ResolvedOutcome {
  disposition: Disposition;
  identityUnverified: boolean;
}

/**
 * Combine the two inputs.
 *
 * 🚨 `not_the_contact` IS NOT REACHABLE FROM A NAMELESS CALL, by construction: the two
 * `identity_not_asked_*` outcomes are the only ones a nameless call can produce, and
 * neither maps to `wrong_person`. 016's CHECK is the backstop that makes the combination
 * unrepresentable even if this function is bypassed.
 */
export function resolveDisposition(
  transport: TransportSignal,
  conversation: ConversationOutcome | null,
): ResolvedOutcome {
  const t = mapTransport(transport);
  if (t.kind === "settled") return { disposition: t.disposition, identityUnverified: false };
  if (conversation === null) {
    // A human picked up and the agent learned nothing. Not a success.
    return { disposition: "unknown_answer", identityUnverified: false };
  }
  switch (conversation) {
    case "identity_confirmed_complete":
      return { disposition: "answered", identityUnverified: false };
    case "identity_confirmed_cut_off":
      return { disposition: "partial", identityUnverified: false };
    case "not_the_contact":
      return { disposition: "wrong_person", identityUnverified: false };
    case "identity_not_asked_complete":
      return { disposition: "answered", identityUnverified: true };
    case "identity_not_asked_cut_off":
      return { disposition: "partial", identityUnverified: true };
  }
}
