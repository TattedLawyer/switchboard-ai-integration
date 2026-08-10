// Core loop / T1 — phone normalisation, and NOTHING else.
//
// DEPENDENCY PROVENANCE, verified at task time from the package's OWN repository rather
// than taken on the research doc's say-so (which flagged it explicitly as unverified):
//
//   package   libphonenumber-js@1.13.10
//   licence   MIT — read from
//             https://gitlab.com/catamphetamine/libphonenumber-js  LICENSE (raw, master):
//             "(The MIT License) Copyright (c) 2016 @catamphetamine". The upstream Google
//             project it ports is Apache-2.0; the port itself is MIT and the package also
//             ships LICENSE.Apache for the derived metadata. NOT Apache-2.0, so the
//             research doc's guess ("commonly MIT, not Apache-2.0") is confirmed and the
//             repo's own NOTICE obligations are unaffected.
//   metadata  the installed metadata sets measured on disk:
//             metadata.min.json 84K · metadata.mobile.json 100K · metadata.full.json 156K
//             · metadata.max.json 156K. We import the package root, which binds
//             `metadata.min.json` — the 84K set. Whole-package unpacked size is 10.2 MB
//             (npm `dist.unpackedSize`), almost all of it alternate builds and typings
//             that are never loaded.
//
// 🚨 WHAT THIS MODULE DELIBERATELY DOES NOT DO, and a hygiene pin watches for it.
// FALSEHOODS.md, on numbers: "Don't store properties for a phone number such as validity
// or type." The library can answer both questions. We never ask, and we export no function
// that answers them, because every such property is a guess that goes stale silently and
// that the rest of this design would then be tempted to branch on. There is no mobile /
// landline distinction anywhere in the CRM schema and there must not be one here.
//
// A number that cannot be parsed is an ERROR RETURN, not a throw and not a null — the
// intake CLI shows it to the operator, who retypes it. Nothing downstream ever sees a
// half-normalised number.
import { parsePhoneNumberFromString } from "libphonenumber-js";

/** The default calling region. Philippines: that is where her prospects are. */
export const DEFAULT_REGION = "PH";

export interface NormalizedPhone {
  /** E.164, the storage form. */
  e164: string;
  /** BYTE-IDENTICAL to what was typed. Not trimmed, not tidied — it is what she wrote,
   *  and it is the only thing that lets her recognise her own entry in a listing. */
  raw: string;
  /** The region the national-format parse was resolved against. */
  region: string;
}

export interface PhoneError {
  error: string;
}

export type PhoneNormalization = NormalizedPhone | PhoneError;

export function isPhoneError(r: PhoneNormalization): r is PhoneError {
  return "error" in r;
}

export function normalizePhone(
  raw: string,
  region: string = DEFAULT_REGION,
): PhoneNormalization {
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
