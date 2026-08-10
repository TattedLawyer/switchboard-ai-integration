// Core loop / T15 pins — the honesty pass.
//
// 🚨 SCOPED TO THE THREE PUBLISHED DOCUMENTS (M3). Rev 2's version of the first pin was
// unscoped and would have RED ON ARRIVAL against `.superpowers/sdd/` — which contains the
// plan, whose §2 lists every one of these words in order to say the system does NOT do
// them — and then been "adjusted", which §4 forbids. A pin that must be softened the moment
// it is written was never a pin.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLISHED = ["README.md", "RUNBOOK.md", "KNOWN-ISSUES.md"];

const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
/** Markdown hard-wraps at ~90 columns, so a claim can straddle a newline. Every pattern
 *  below is matched against the FLATTENED text — otherwise the pin's sensitivity depends on
 *  where a line happened to wrap, which is not a property of anything. */
const flat = (rel: string): string => read(rel).replace(/\s+/g, " ");

/** Every markdown document the repo publishes: the root files plus `docs/`. Deliberately
 *  NOT `.superpowers/sdd/`, which is the working record and argues about these claims by
 *  quoting them. */
function publishedDocs(): string[] {
  const out = PUBLISHED.slice();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${entry}`;
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, prefix);
      else if (entry.endsWith(".md")) out.push(rel);
    }
  };
  walk("docs", "docs");
  out.push("harness/README.md");
  return out;
}

/** A claim is a positive sentence. These patterns are written to match the CLAIM and not
 *  the DENIAL — "no inbound calls" must not trip a pin about inbound calls, or the honest
 *  disclosure becomes unwritable. */
const FORBIDDEN_CLAIMS: Array<[label: string, re: RegExp]> = [
  ["inbound calls", /\b(accepts?|handles?|supports?|receives?) inbound calls\b/i],
  ["SMS", /\b(sends?|supports?|handles?) SMS\b/i],
  ["email sequences", /\b(sends?|supports?|runs?) (an? )?(email )?sequences?\b/i],
  ["consent gating", /\bconsent (gate|gating|is (checked|enforced|verified))\b/i],
  ["a DNC list", /\b(checks?|honou?rs?|maintains?|screens? against) (the |a )?DNC\b/i],
  ["high availability", /\b(highly available|high[- ]availability|HA) (deployment|mode|setup)\b/i],
  ["a dashboard", /\b(ships?|provides?|includes?) (a )?(client )?dashboard\b/i],
  ["stored audio", /\b(records?|stores?|retains?) (the )?(call )?audio\b/i],
  ["stored transcripts", /\b(stores?|retains?|persists?) (the )?transcripts?\b/i],
];

describe("T15: the three published documents claim nothing the loop does not do", () => {
  // mutation: add "The system supports inbound calls." to README.md -> red.
  //           RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 8 passed (9)`
  //     AssertionError: expected [ Array(1) ] to deeply equal []
  //   Run a second time against a DIFFERENT document and a different claim — "Switchboard
  //   stores the transcript for every call." appended to RUNBOOK.md — with the same result,
  //   so the pin is not sensitive to only one file or only one pattern.
  it.each(PUBLISHED)("%s makes no claim from the forbidden list", (doc) => {
    const text = flat(doc);
    const found: string[] = [];
    for (const [label, re] of FORBIDDEN_CLAIMS) {
      const m = re.exec(text);
      if (m) found.push(`${doc}: ${label} — ${JSON.stringify(m[0])}`);
    }
    expect(found).toEqual([]);
  });
});

describe("T15: the summary keeps the docs honest", () => {
  // mutation: add "The system stores no conversation content." to README.md -> red.
  //           RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 8 passed (9)`
  //     AssertionError: expected [ 'README.md' ] to deeply equal []
  //
  // 🚨 THIS IS THE PIN THAT KEEPS THE SUMMARY HONEST. "No transcript is stored" is true and
  // is the sentence everyone reaches for; "no conversation content is stored" is FALSE, and
  // the two are one careless edit apart.
  it("no published doc claims the system stores no conversation content", () => {
    const offenders: string[] = [];
    for (const doc of publishedDocs()) {
      if (/no conversation content|stores? nothing (the (client|prospect)) said/i.test(flat(doc))) {
        offenders.push(doc);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("README says out loud that the summary IS conversation content", () => {
    // Vacuity guard: the pin above passes trivially on a document that says nothing at all
    // about the summary. This asserts the positive disclosure exists.
    expect(flat("README.md")).toMatch(/does store conversation content/i);
  });
});

describe("T15: the CRM↔approval link is never described as an enforced foreign key", () => {
  // mutation: add "The touch's proposal_id is a foreign key into approval.proposals." to
  //           README.md -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 8 passed (9)`
  //     AssertionError: expected [ 'README.md' ] to deeply equal []
  it("no published doc says foreign key about that link", () => {
    const offenders: string[] = [];
    for (const doc of publishedDocs()) {
      const text = flat(doc);
      if (/proposal_id is a foreign key|foreign key into approval\./i.test(text)) {
        offenders.push(doc);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("README says the opposite, explicitly", () => {
    expect(flat("README.md")).toMatch(/is not an enforced foreign key/i);
  });
});

describe("T15: no doc claims a failed transcript can be recovered", () => {
  // mutation: add "A failed transcript send can be retried from the stored copy." to
  //           RUNBOOK.md -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 8 passed (9)`
  //     AssertionError: expected [ 'RUNBOOK.md' ] to deeply equal []
  //
  // The design is NOT lossless, on two named paths, and a document that implies otherwise
  // is worse than no document: she would stop looking for the record she has lost.
  it("no published doc offers a recovery path for a lost transcript", () => {
    const offenders: string[] = [];
    for (const doc of publishedDocs()) {
      const text = flat(doc);
      if (
        /(recover|restore|re-?send|retry) (the |a )?transcript from|transcript can be (recovered|restored|recreated)/i.test(
          text,
        )
      ) {
        offenders.push(doc);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("README and KNOWN-ISSUES both say the transcript is gone", () => {
    expect(flat("README.md")).toMatch(/the transcript is gone/i);
    expect(flat("KNOWN-ISSUES.md")).toMatch(/the transcript is gone/i);
    expect(flat("README.md")).toMatch(/not lossless/i);
  });
});
