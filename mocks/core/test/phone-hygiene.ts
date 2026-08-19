// Phone hygiene for a Philippines-first product that does outbound calling.
//
// The repo-wide guard in repo-hygiene.test.ts used to run only US-shaped detectors, so
// it could not see a PH mobile number at all — and it MISREAD the legitimate fixture
// spelling `+63 917 111 2222` as a US number (the space after +63 is a word boundary,
// so the trailing `9XX XXX XXXX` part matched US_PHONE_SHAPE). It flagged a fake number and
// would have missed a real one. This module is the fix: a pure, corpus-testable scanner
// that (1) recognises PH mobiles in their real spellings, (2) masks every PH match with
// SAME-LENGTH filler before the US/SSN passes run, and (3) admits only a frozen,
// human-attested set of synthetic fixture numbers.

// The mobile second-digit class, pinned as a visible constant so the coverage decision
// is explicit and testable (repo-hygiene P2). PH mobile numbers are 0 9XX XXX XXXX
// nationally; DITO's allocations start with 8 (0895/0896/0898/0817 … all parse valid
// under this repo's own libphonenumber-js), so a 9XX-only class would silently drop a
// whole carrier.
export const PH_MOBILE_SECOND_DIGIT = "[89]";

// THE REGEX, with its reasoning:
//
//   (?<!\d)(?:\+63[ .-]?|63|0)[89]\d{2}[ .-]?\d{3}[ .-]?\d{4}
//
// · Prefix alternatives cover the real spellings: `+63` (optionally separated from the
//   subscriber part), bare `63…` (contiguous international without the plus), and the
//   national `0…` form, with `0`/`63` required ADJACENT to the mobile prefix — nobody
//   writes `0 9XX`, and requiring adjacency keeps decimals like `0.9…` out.
// · After the prefix: exactly 10 subscriber digits ([89] + 2 + 3 + 3+4 grouping), with
//   ` `, `-` or `.` optionally between the conventional groups. Fixed total length is
//   enforced by construction — every alternative admits exactly 11 national or
//   63+10 international digits, never a shorter prefix of one.
// · `(?<!\d)` forbids starting mid-digit-run, so the tail of a longer number (e.g.
//   `1091…`) can never be misread as a PH mobile.
// · There is deliberately NO trailing (?!\d): a fixture number immediately followed by
//   more digits (the digit-merge case pinned in P5) must still be recognised and
//   masked. The cost — the first 11 digits of a longer 0[89]…/63[89]… run can match —
//   errs on the loud side, which is the right direction for a hygiene tripwire.
export const PH_MOBILE = new RegExp(
  String.raw`(?<!\d)(?:\+63[ .-]?|63|0)${PH_MOBILE_SECOND_DIGIT}\d{2}[ .-]?\d{3}[ .-]?\d{4}`,
  "g",
);

// The US-shaped detectors, unchanged from the original guard. NOTE, honestly: the
// tracked tree currently contains ZERO US-shaped literals, so today these arms protect
// nothing — they are FUTURE tripwires kept so a US-shaped number or SSN pasted into a
// doc or fixture fails loudly the day it lands. (Exported without the g flag so
// `.test()` in the self-tests stays stateless; the scanner builds its own /g copies.)
export const SSN_SHAPE = /\b\d{3}-\d{2}-\d{4}\b/;
export const US_PHONE_SHAPE = /\b\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/;

// Canonical E.164 for allowlist keying: strip separators, map national `0…` onto
// `+63…`, prefix bare `63…` with `+`. Every spelling of one fixture number collapses to
// one key — an earlier hand count reached 19 "distinct" numbers precisely because it
// failed to canonicalise `0XXX…` against `+63…`.
export function canonicalPhMobile(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return "+" + (digits.startsWith("0") ? "63" + digits.slice(1) : digits);
}

// The allowlist of permitted synthetic fixture numbers, keyed on canonical E.164.
// Derived MECHANICALLY (scan of every git-tracked text file with PH_MOBILE +
// canonicalPhMobile, 2026-08-18: 22 files, exactly these 13 numbers) — and then FROZEN.
//
// HONEST SEMANTICS: this is a frozen, HUMAN-ATTESTED fixture set, NOT a mechanical
// guarantee. Unlike `*.example.com` (IANA-reserved — mail to it can never arrive),
// every number below is libphonenumber-valid and potentially DIALABLE BY THIS VERY
// PRODUCT. Nothing about being on this list makes a number safe; the only real control
// is diff review of edits to this file. Do not add an entry without attesting, in the
// diff, where it is used and why it is known synthetic.
export const PH_FIXTURE_ALLOWLIST: ReadonlySet<string> = new Set([
  "+639170001111", // proposer-sheet fixtures (crm) — attested synthetic, 2026-08-18
  "+639171111111", // proposer + proposer-sheet fixtures (crm) — attested synthetic, 2026-08-18
  "+639171112222", // no-silence + proposer-sheet fixtures (crm) — attested synthetic, 2026-08-18
  "+639171234567", // the repo's workhorse fixture: RUNBOOK, approval + 19 crm files — attested synthetic, 2026-08-18
  "+639172222222", // proposer fixtures (crm) — attested synthetic, 2026-08-18
  "+639173333333", // proposer fixtures (crm) — attested synthetic, 2026-08-18
  "+639173334444", // no-silence + proposer-sheet fixtures (crm) — attested synthetic, 2026-08-18
  "+639175550000", // proposer-sheet fixtures (crm) — attested synthetic, 2026-08-18
  "+639178888888", // lifecycle fixtures (crm) — attested synthetic, 2026-08-18
  "+639179998888", // proposer-sheet + sheet-adopt fixtures (crm) — attested synthetic, 2026-08-18
  "+639179999999", // approval place-call-payload + crm executor/lifecycle/no-silence/proposer — attested synthetic, 2026-08-18
  "+639181234567", // sheet-columns fixtures (crm) — attested synthetic, 2026-08-18
  "+639185551234", // sheet-columns source + sheet-adopt/sheet-link tests (crm) — attested synthetic, 2026-08-18
]);

// Size cap. Stated honestly: this bounds VOLUME, not VERACITY — a wrong number under
// the cap is still wrong, and the attestation/diff-review control above is what stands
// between the list and a real number. The cap exists to force a conversation before the
// fixture population grows quietly (13 today; 3 slots of headroom).
export const PH_FIXTURE_ALLOWLIST_CAP = 16;

// The scan, as a pure function over (file, text) pairs so it is testable against
// synthetic corpora — the repo-wide caller wires in the real `git ls-files` corpus and
// pins that wiring separately (repo-hygiene P8).
//
// Order matters and is load-bearing:
//   1. PH mobiles are matched FIRST. Every match — allowlisted or not — is replaced
//      with SAME-LENGTH non-digit filler ("#" × length). Masking, never deletion:
//      deletion splices the match's neighbours together and FABRICATES offenders that
//      exist nowhere in the file — verified by execution: deleting the PH match from
//      "ref 415-0917 111 2222555-0142" splices `415-` onto `555-0142` (a US shape),
//      and from "078-0917 111 222205-1120" splices `078-` onto `05-1120` (an SSN
//      shape). The fabricated results are deliberately not spelled contiguously in
//      this comment — the repo-wide scan reads this file too once it is tracked.
//      Same-length filler moves nothing, so it can fabricate nothing.
//   2. Non-allowlisted PH matches are reported, named by file AND number.
//   3. US_PHONE_SHAPE and SSN_SHAPE then run on the MASKED text, so a PH number's own
//      digits can never be misread as a US shape (`+63 917 111 2222` was, before).
export function findPhoneOffenders(
  texts: ReadonlyArray<readonly [string, string]>,
  allowlist: ReadonlySet<string>,
): string[] {
  const offenders: string[] = [];
  for (const [file, text] of texts) {
    const masked = text.replace(PH_MOBILE, (m) => {
      const canonical = canonicalPhMobile(m);
      if (!allowlist.has(canonical)) {
        offenders.push(`${file}: ${m} (PH mobile, canonical ${canonical}, not in the fixture allowlist)`);
      }
      return "#".repeat(m.length);
    });
    for (const m of masked.matchAll(new RegExp(US_PHONE_SHAPE.source, "g"))) {
      offenders.push(`${file}: ${m[0]} (US-phone-shaped)`);
    }
    for (const m of masked.matchAll(new RegExp(SSN_SHAPE.source, "g"))) {
      offenders.push(`${file}: ${m[0]} (SSN-shaped)`);
    }
  }
  return offenders;
}
