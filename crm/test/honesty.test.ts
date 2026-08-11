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

  it("README discloses that stored content IS conversation content", () => {
    // Vacuity guard: the pin above passes trivially on a document that says nothing at all.
    // This asserts the positive disclosure exists. In Wave 1 the STORED ANSWERS are the
    // prospect's own words (conversation content) even though the summary is not written yet;
    // when the summary ships it is a second such store. Either phrasing satisfies the guard,
    // so it survives the Wave-1→Wave-2 transition without needing an edit.
    expect(flat("README.md")).toMatch(
      /store(s)? conversation content|the stored answers are (her|the) (client'?s|prospect'?s) (own )?words/i,
    );
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

describe("T15 / I1: no Wave-1 doc presents an UNBUILT mechanism as operating", () => {
  // 🚨 THE RECURRING FAILURE CLASS ON THIS PROJECT, and T15's other pins do not catch it:
  // they test for FORBIDDEN claims (inbound calls, an enforced FK, a recoverable
  // transcript), never for CLAIMING A MECHANISM THE CODE DOES NOT IMPLEMENT. C1's review
  // found README describing summarisation and transcript email in the present tense while
  // T17/T18 are Wave 2 and unbuilt.
  //
  // The pin is CODE-GROUNDED: it reads whether a writer exists, and only then constrains the
  // docs. When Wave 2 lands and a writer appears, the guarded block simply stops applying —
  // the pin never has to be "adjusted".
  function crmSrc(): string {
    let out = "";
    for (const f of readdirSync(join(ROOT, "crm", "src"))) {
      if (f.endsWith(".ts")) out += readFileSync(join(ROOT, "crm", "src", f), "utf8");
    }
    for (const sub of ["cli"]) {
      for (const f of readdirSync(join(ROOT, "crm", "src", sub))) {
        if (f.endsWith(".ts")) out += readFileSync(join(ROOT, "crm", "src", sub, f), "utf8");
      }
    }
    return out;
  }

  // mutation: put the operating claim back — restore
  //           "answers stored per question · summary stored · transcript emailed" to the
  //           README diagram -> red. RUN ✅ 2026-08-10
  //   Observed: `Tests  1 failed | 10 passed (11)`
  //     AssertionError: README.md presents summary/transcript as operating while no code
  //                     writes them: expected '…' not to match /answers stored per question
  //                     · summary stored · transcript emailed/
  it("does not claim summary/transcript are stored while nothing writes them", () => {
    const src = crmSrc();
    // Does a real Wave-2 writer exist yet? (Comments are noise but harmless here — a
    // commented writer would only make the guard STRICTER, never falsely relax it.)
    const transcriptWriterExists =
      /transcript_delivery['"\s]*=\s*['"](sent|failed)/.test(src) ||
      /send(Transcript|Email)\s*\(/.test(src);
    const summaryWriterExists = /\bsummary_state\b\s*=/.test(src) || /set\s+summary\b/.test(src);

    if (transcriptWriterExists && summaryWriterExists) return; // Wave 2 shipped; pin retires

    // Wave 1: the docs must NOT present the pipeline as storing a summary or emailing a
    // transcript as an operating fact, and MUST carry an explicit not-built marker.
    for (const doc of PUBLISHED) {
      expect(
        flat(doc),
        `${doc} presents summary/transcript as operating while no code writes them`,
      ).not.toMatch(/answers stored per question\s*·\s*summary stored\s*·\s*transcript emailed/i);
    }
  });

  // mutation: delete the "no summarisation and no transcript email built" disclosure from
  //           README -> red. RUN ✅ 2026-08-10
  //   Observed: `Tests  1 failed | 11 passed (12)`
  //     AssertionError: expected '…' to match /no summarisation and no transcript email built/
  it("README says out loud that summarisation and transcript email are not built", () => {
    // Vacuity guard for the pin above: the positive disclosure must exist.
    expect(flat("README.md")).toMatch(/no summarisation and no transcript email built/i);
  });

  // 🚨 IMPORTANT 1 from the gate review — the harmful-direction claim. The proposer builds
  // approvable `send_email` cards, but there is NO email executor, so an approved email is
  // never sent. A doc that implies email is "not built at all" (inert) invites the operator
  // to enroll email contacts and lose the delivery they think is happening.
  //
  // mutation: change README's "there is no email executor" disclosure to "email is fully
  //           inert / no email path is built" -> red. RUN ✅ 2026-08-10
  //   Observed: `Tests  1 failed | 11 passed (12)`
  //     AssertionError: expected '…' to match /no email executor/i  (the disclosure of the
  //                     half-wired reality is gone once the doc claims email is inert)
  it("does not claim the email path is inert while the proposer builds send_email cards", () => {
    const src = crmSrc();
    // The proposer DOES build send_email cards today (grounded, not asserted from the doc).
    const emailCardsAreBuilt = /action_type:\s*["']send_email["']/.test(src);
    // An email EXECUTOR does not exist yet.
    const emailExecutorExists = /send(Email|Transcript)\s*\(/.test(src);
    if (!emailCardsAreBuilt || emailExecutorExists) return; // reality changed; pin retires

    const readme = flat("README.md");
    // Positive: README must disclose the half-wired reality (cards built, no executor).
    expect(readme).toMatch(/no email executor/i);
    // Negative: README must NOT claim the email path is wholly unbuilt/inert.
    expect(readme).not.toMatch(/no email path built at all|email is (fully )?inert/i);
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
