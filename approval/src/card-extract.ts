// Business-card extraction — the vendor seam, and ONLY the seam.
//
// WHY THIS LIVES IN `approval/src` AND NOT `crm/src`: 69ad456 closed cross-workspace src
// imports in BOTH directions (crm/src/executor.ts:34 states the crm→approval ban; the
// approval workspace declares no dependency on `@switchboard/crm`, whose exports map
// exposes nothing but its package.json — so approval→crm does not resolve either). The
// composition root in `scripts/` is the one thing allowed to cross, and the capture
// routes must typecheck; a seam they cannot import is not a seam. So the type lives here,
// next to its only consumer (`card-capture.ts`).
//
// 🚨 THE IMAGE IS AN ARGUMENT, NEVER A RESIDENT. An `ExtractCard` receives the photo's
// bytes for the duration of ONE call and returns text fields. Nothing in this contract
// permits writing the image anywhere — no disk, no database, no session. That is owner
// ruling 2 (do not store the photo), and card-capture.test.ts C2 watches for violations
// with a sentinel scan and fs spies.
//
// 🚨 EXTRACTION IS A PROPOSAL, NOT A FACT. Whatever an extractor returns is pre-filled
// into a form the broker EDITS AND CONFIRMS; the contact is created from her confirmed
// values only (owner ruling 1). An extractor therefore never needs to be right — it needs
// to be honest: return null / [] for what it cannot read, never a guess dressed as a read.

/** What an extractor believes it saw on the card. Every field is a BELIEF the broker
 *  confirms or corrects — nothing here reaches storage unreviewed. `raw` is the full
 *  recognised text, for extractors that have it; the form shows it so she can rescue a
 *  field the structured parse missed. */
export type CardFields = {
  name: string | null;
  company: string | null;
  email: string | null;
  phones: string[];
  raw: string | null;
};

export type ExtractCard = (image: {
  bytes: Uint8Array;
  mimeType: string;
}) => Promise<CardFields>;

/**
 * The no-vendor extractor, and the DEFAULT. Returns nothing at all — which the capture
 * surface must treat as a first-class outcome: the confirmation form renders empty and
 * the broker types the details herself. The feature is useful with no vendor configured,
 * ever (card-capture.test.ts C5); an extractor only ever saves her typing.
 */
export const stubExtractCard: ExtractCard = async () => ({
  name: null,
  company: null,
  email: null,
  phones: [],
  raw: null,
});

/** Everything a real vendor adapter will need, injected — NEVER read from `process.env`
 *  in this module (the `call-transport.ts` doctrine: the thing that touches the outside
 *  world takes its authority explicitly). */
export interface VendorExtractConfig {
  /** Which OCR/vision vendor the owner chose. No choice has been made yet. */
  vendor: string;
  /** The vendor credential. */
  apiKey: string;
  /** The vendor endpoint or model identifier, whichever the vendor's API needs. */
  endpoint: string;
}

/**
 * Factory for the REAL vendor extractor. THROWS AT CONSTRUCTION when unconfigured — the
 * same doctrine as `crm/src/call-transport.ts`'s injected config and `smtpSender`'s
 * constructor arguments: a half-configured adapter must refuse to exist, not exist and
 * fail on the first card.
 *
 * 🚨 THE BODY IS DELIBERATELY NOT IMPLEMENTED. The owner has not chosen a vendor, so
 * there is no SDK dependency here and no network call — the throw below names exactly
 * what a human must supply before this function can be finished. Until then the stub
 * above is the production default and the form does the whole job.
 */
export function vendorExtractCard(config: Partial<VendorExtractConfig>): ExtractCard {
  const missing = (["vendor", "apiKey", "endpoint"] as const).filter(
    (k) => typeof config[k] !== "string" || config[k] === "",
  );
  if (missing.length > 0) {
    throw new Error(
      `vendorExtractCard refuses to construct: missing config ${missing.join(", ")}. ` +
        "A real extractor takes its vendor, credential and endpoint explicitly — it never " +
        "reads the environment (call-transport.ts doctrine).",
    );
  }
  return async () => {
    throw new Error(
      `card extraction vendor "${config.vendor}" is not implemented: no OCR vendor has ` +
        "been chosen for this deployment yet. Implement this adapter against the chosen " +
        "vendor's API (input: image bytes + mime type; output: CardFields with null/[] " +
        "for anything unread), or unwire it and rely on the manual form.",
    );
  };
}
