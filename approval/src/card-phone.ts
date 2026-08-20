// Phone normalisation for the card-capture surface — a DELIBERATE DUPLICATE of
// `crm/src/phone.ts`, the house cross-workspace idiom (approval/test/canonical.test.ts
// V15; crm/src/sheet-columns.ts:9 precedent): 69ad456 closed cross-workspace src imports,
// and a capture surface that stored numbers the CRM's own normaliser would refuse — or
// normalised them differently — would poison the dial rotation at its source.
//
// 🚨 KEEP IN SYNC with crm/src/phone.ts. The invariants that must not drift:
//   · E.164 out, raw preserved BYTE-IDENTICAL (it is what she recognises in a listing);
//   · unreadable is an ERROR RETURN, never a throw, never a null, never a guess;
//   · NO validity/type properties — FALSEHOODS.md's rule, phone.ts's header: every such
//     property is a guess that goes stale silently;
//   · same library, same pinned version (libphonenumber-js 1.13.10, provenance audited in
//     phone.ts's header — MIT, metadata.min.json binding).
import { parsePhoneNumberFromString } from "libphonenumber-js";

/** The default calling region. Philippines: that is where her prospects are. */
export const DEFAULT_REGION = "PH";

export interface NormalizedCardPhone {
  e164: string;
  /** Byte-identical to what she typed or confirmed. */
  raw: string;
  region: string;
}

export interface CardPhoneError {
  error: string;
}

export type CardPhoneNormalization = NormalizedCardPhone | CardPhoneError;

export function isCardPhoneError(r: CardPhoneNormalization): r is CardPhoneError {
  return "error" in r;
}

export function normalizeCardPhone(
  raw: string,
  region: string = DEFAULT_REGION,
): CardPhoneNormalization {
  let parsed;
  try {
    parsed = parsePhoneNumberFromString(raw, region as never);
  } catch {
    parsed = undefined;
  }
  if (!parsed) {
    return { error: `could not read "${raw}" as a phone number in region ${region}` };
  }
  return { e164: parsed.number, raw, region };
}
