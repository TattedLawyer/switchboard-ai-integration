// Regenerates the TWO committed ISO-4217 artifacts from a LOCALLY-FETCHED copy of SIX's
// published list-one.xml:
//
//   <a local list-one.xml, fetched by the maintainer, NOT stored in this repo>
//     ├─→ ingest/src/iso4217-codes.ts          — the ingest door's allowlist
//     └─→ warehouse/seeds/iso_4217_currencies.csv — dbt's seed, joined by the three
//                                                   staging models' currency guard
//
// Run: npx tsx scripts/generate-iso4217.ts <path-to-list-one.xml>   (then commit the diffs)
//
// The source file is NOT vendored. This repo ships only the DERIVED artifacts: the code
// set it admits, rendered into a TypeScript module and a dbt seed. Provenance — source
// URL, published date, SHA-256 of the exact bytes the committed artifacts were rendered
// from, and the refresh procedure — is recorded in vendor/iso-4217/README.md. That
// separation is deliberate; the reasoning is in that file.
//
// Why generated-and-committed rather than hand-typed or fetched at build time: a
// hand-typed ~180-entry list is the exact hand-copy class the numeric_bounds seed
// machinery exists to close ("nothing mechanically diffs them" — KNOWN-ISSUES), and it
// ages silently. A build-time fetch would make the door's behaviour depend on a network
// and a vendor's uptime, and would remove the reviewable diff. So the artifacts are
// committed tree state and this script is run deliberately, by a human, on a refresh.
//
// Same relative-import exemption as ci-fixture.ts and generate-numeric-bounds-seed.ts
// (script code, not shipped src).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  admittedCodes,
  parseListOne,
  renderIso4217Csv,
  renderIso4217Module,
  EXCLUDED_CODES,
} from "../ingest/src/iso4217.js";

const xmlPath = process.argv[2];
if (xmlPath === undefined) {
  console.error(
    "usage: npx tsx scripts/generate-iso4217.ts <path-to-list-one.xml>\n\n" +
      "The ISO-4217 source table is NOT vendored in this repo — fetch it first:\n" +
      "  curl -sSLo /tmp/list-one.xml \\\n" +
      "    https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml\n" +
      "Then re-run with that path. See vendor/iso-4217/README.md.",
  );
  process.exit(2);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = join(repoRoot, "ingest/src/iso4217-codes.ts");
const seedPath = join(repoRoot, "warehouse/seeds/iso_4217_currencies.csv");

const xmlBytes = readFileSync(xmlPath);
const sourceSha256 = createHash("sha256").update(xmlBytes).digest("hex");
const list = parseListOne(xmlBytes.toString("utf8"));

const wrote = (path: string, next: string): string => {
  const prev = ((): string | null => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  })();
  writeFileSync(path, next);
  return prev === next ? "unchanged" : "WRITTEN";
};

const moduleState = wrote(modulePath, renderIso4217Module(list));
const seedState = wrote(seedPath, renderIso4217Csv(list));
console.log(
  `source ${xmlPath}\n` +
    `  published ${list.published}, sha256 ${sourceSha256}\n` +
    `  ${list.codes.length} published codes, ${admittedCodes(list).length} admitted ` +
    `(excluding ${EXCLUDED_CODES.join(", ")})\n` +
    `  ingest/src/iso4217-codes.ts             ${moduleState}\n` +
    `  warehouse/seeds/iso_4217_currencies.csv ${seedState}\n\n` +
    "RECORD THE SHA-256 ABOVE in vendor/iso-4217/README.md alongside the published date —\n" +
    "it is the only remaining link between these artifacts and the bytes they came from.",
);
