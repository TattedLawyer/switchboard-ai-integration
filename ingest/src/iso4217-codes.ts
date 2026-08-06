// GENERATED FILE — DO NOT EDIT BY HAND.
//
// The ISO-4217 codes the ingest door admits, rendered by scripts/generate-iso4217.ts
// from SIX's published list-one.xml. That source file is NOT vendored in this repo —
// its URL, published date and SHA-256, and the refresh procedure, live in
// vendor/iso-4217/README.md. Excluded as published-but-not-billable:
// XTS, XXX — XXX is "no currency", XTS is "reserved for testing".
//
// Never edit this file by hand: re-run the generator against a freshly fetched source
// and update the golden hashes in ingest/test/iso4217.test.ts in the same commit.

/** The `Pblshd` attribute of the list-one.xml this file was rendered from. */
export const ISO_4217_PUBLISHED = "2026-01-01";

/** Sorted, deduplicated, exclusions removed. 176 codes. */
export const ISO_4217_CURRENCIES: readonly string[] = [
  "AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG",
  "AZN", "BAM", "BBD", "BDT", "BHD", "BIF", "BMD", "BND",
  "BOB", "BOV", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD",
  "CAD", "CDF", "CHE", "CHF", "CHW", "CLF", "CLP", "CNY",
  "COP", "COU", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK",
  "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP",
  "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD",
  "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IQD",
  "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR",
  "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP",
  "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD",
  "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN",
  "MXV", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR",
  "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN",
  "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD",
  "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD",
  "SSP", "STN", "SVC", "SYP", "SZL", "THB", "TJS", "TMT",
  "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX",
  "USD", "USN", "UYI", "UYU", "UYW", "UZS", "VED", "VES",
  "VND", "VUV", "WST", "XAD", "XAF", "XAG", "XAU", "XBA",
  "XBB", "XBC", "XBD", "XCD", "XCG", "XDR", "XOF", "XPD",
  "XPF", "XPT", "XSU", "XUA", "YER", "ZAR", "ZMW", "ZWG",
];

const CURRENCY_SET: ReadonlySet<string> = new Set(ISO_4217_CURRENCIES);

/** Exact, case-sensitive membership. Nothing is normalized: a lowercase code is a
 *  vendor bug the operator must see, not a value to quietly repair. */
export function isIso4217(code: string): boolean {
  return CURRENCY_SET.has(code);
}
