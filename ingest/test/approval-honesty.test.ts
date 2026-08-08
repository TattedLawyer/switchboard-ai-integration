// Phase 3 / A2, T11 — the honesty pass, as a test rather than a promise.
//
// THE CLAIM BEING POLICED, and why it is counter-intuitive enough to need a machine
// watching it: as the agent gets BETTER, human approval provides LESS protection, not
// more. Mosier & Manzey 2019 — omission errors rose 32.4% -> 48.3% as decision-aid
// reliability rose .87 -> .98 (Bailey & Scerbo 2007); back-end aids that recommend ONE
// SPECIFIC ACTION are worse than front-end aids; experts are as susceptible as novices;
// and externally imposed accountability did not replicate in professionals. Our queue is
// the worst-configured aid in that literature: back-end, one recommendation, intended to
// become highly reliable.
//
// So safety rests on the READ-ONLY CREDENTIAL and the IMMUTABILITY TRIGGER — mechanisms
// that hold whether or not anyone read the card — and NOT on the broker's attention. No
// document in this repo may say otherwise, and the temptation to say otherwise is
// permanent, because "a human approves everything" is the most reassuring sentence
// available.
//
// 🚨 THE PIN IS TWO-DIRECTIONAL, AND THAT IS DELIBERATE. A pin that only FORBIDS a phrasing
// is routed around by paraphrase within a week. So it also REQUIRES the demotion to be
// present, in both documents that carry it.
//
// 🚨 AND IT IS BASELINED. Three true, legitimate, hard-won sentences already say
// "database-enforced" — README:34, agent-writer-boundary.md:121, RUNBOOK:19 — and every
// one of them is about the READ-ONLY ROLE, which really is database-enforced. An earlier
// version of this pin matched on lexical proximity to the word "approve" and would have
// red against all three; the only ways to green it would have been to weaken the pattern or
// to allowlist the files, i.e. to TUNE THE PIN TO GREEN rather than design it. So the
// pattern anchors on the SUBJECT of the enforcement claim, and the three sentences are
// pasted in below as a known-good baseline that must keep passing.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

const DOCS = [
  "README.md",
  "RUNBOOK.md",
  "KNOWN-ISSUES.md",
  "docs/adr/agent-writer-boundary.md",
  "docs/adr/approver-identity.md",
];

/** The SUBJECT: the thing a sentence might wrongly claim is enforced or primary. Never
 *  the bare word "approve" — that is what made the earlier pattern red against true
 *  sentences about the read-only role. */
const APPROVAL_SUBJECT =
  /(human approval|approval by a human|the approver'?s? (?:attention|judgement|judgment|review)|human oversight|human review|the human in the loop|human-in-the-loop)/i;

/** The PREDICATE: the claim that must never attach to that subject. */
const ENFORCEMENT_PREDICATE =
  /(database-enforced|enforced by the database|primary safeguard|primary safety|primary protection|main safeguard|principal safeguard|what keeps (?:her|the client|users) safe|the safeguard that matters most)/i;

/** The three TRUE sentences the pin must not red against. Pasted verbatim so the baseline
 *  is a known set rather than something a future reader rediscovers. */
const BASELINE_TRUE_SENTENCES = [
  "*(a) database-enforced, at runtime, in every deployment* — the agent's connection authenticates as a role holding `usage` and `select` and nothing else",
  "**Database-enforced, at runtime, in every deployment:** the subject is `switchboard_agent`",
  "It must point at `switchboard_agent`, the **database-enforced read-only role**",
];

/** Sentence-ish split. Deliberately crude: over-splitting makes the pin STRICTER (a
 *  subject and a predicate must land in the same fragment), never laxer. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;:])\s+|\n\s*\n|\n[-|*]\s|\n#+\s/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function overclaims(text: string): string[] {
  return sentences(text).filter(
    (s) => APPROVAL_SUBJECT.test(s) && ENFORCEMENT_PREDICATE.test(s),
  );
}

const read = (rel: string): string => readFileSync(join(REPO, rel), "utf8");

describe("A2/T11: no document may promote human approval to the primary safeguard", () => {
  it("finds no overclaim anywhere in the published set", () => {
    // mutation: seed an overclaim — see the sensitivity test below, which does exactly
    //           that and asserts the pattern catches it. RUN ✅ 2026-08-08
    const found: string[] = [];
    for (const doc of DOCS) {
      for (const s of overclaims(read(doc))) found.push(`${doc}: ${s}`);
    }
    expect(found, `an overclaim shipped:\n${found.join("\n")}`).toEqual([]);
  });

  it("PASSES against the three true sentences about the read-only role (the baseline)", () => {
    // 🚨 IF THIS REDS, THE PATTERN IS WRONG, NOT THE BASELINE. These three are true, they
    // are about `switchboard_agent`, and they are text an earlier task fought for.
    for (const s of BASELINE_TRUE_SENTENCES) {
      expect(overclaims(s), `the pattern reds against a TRUE sentence: ${s}`).toEqual([]);
    }
    // ...and they really are present in the repo, so the baseline is not asserting about
    // sentences nobody ships.
    expect(read("README.md")).toContain("*(a) database-enforced, at runtime, in every deployment*");
    expect(read("docs/adr/agent-writer-boundary.md")).toContain(
      "**Database-enforced, at runtime, in every deployment:**",
    );
    expect(read("RUNBOOK.md")).toContain("**database-enforced read-only role**");
  });

  it("FAILS against a seeded overclaim — the pattern is not vacuous", () => {
    // The sensitivity half. Without this the absence assertion above passes for any
    // pattern at all, including one that matches nothing.
    const seeded = [
      "Human approval is the primary safeguard against an agent acting on its own.",
      "The approver's attention is database-enforced.",
      "Human oversight is what keeps her safe.",
      "Human-in-the-loop review is the main safeguard here.",
    ];
    for (const s of seeded) {
      expect(overclaims(s), `the pattern missed a seeded overclaim: ${s}`).toHaveLength(1);
    }
  });
});

describe("A2/T11: the demotion is PRESENT, not merely un-contradicted", () => {
  const DEMOTION = "provides LESS protection, not more";

  it("appears in the approver-identity ADR", () => {
    // mutation: delete the demotion paragraph from the ADR -> this reds. RUN ✅ 2026-08-08
    const adr = read("docs/adr/approver-identity.md");
    expect(adr).toContain(DEMOTION);
    // ...with the mechanisms it demotes TO, named, so the sentence is a redirection rather
    // than a shrug.
    expect(adr).toMatch(/read-only credential/i);
    expect(adr).toMatch(/immutability trigger/i);
  });

  it("appears in KNOWN-ISSUES as a design disclosure", () => {
    const ki = read("KNOWN-ISSUES.md");
    expect(ki).toContain(DEMOTION);
    expect(ki).toMatch(/reliability paradox/i);
  });

  it("names the three things that do NOT answer it", () => {
    // The binding consequence, and the one most likely to be forgotten: better card
    // design, warning text and accountability framing ALL FAIL against this evidence.
    // A future proposal that answers the paradox with UI is answering it with the three
    // things measured not to work.
    const adr = read("docs/adr/approver-identity.md");
    for (const dead of [/card design/i, /warning text/i, /accountability/i]) {
      expect(adr, `the ADR does not rule out ${dead}`).toMatch(dead);
    }
  });
});

describe("A2/T11: the two documents A2 FALSIFIED are corrected at head", () => {
  it("RUNBOOK's cap row no longer publishes the rejected-state manual drain", () => {
    // mutation: restore `set state = 'rejected'` to the RUNBOOK cap row -> this reds.
    //           RUN ✅ 2026-08-08
    //
    // The published remedy was `update approval.proposals set state = 'rejected' where
    // state = 'pending'`. A2's widened trigger makes that statement RAISE — deliberately,
    // because a rejection is a human decision and an operator draining a wedged queue is
    // not deciding anything. The correct target is `expired`: nobody decided, and the asks
    // aged out. A published remedy that has silently become a failing statement is worse
    // than no remedy, and the person who reads it is debugging at the moment when being
    // wrong is most expensive.
    const runbook = read("RUNBOOK.md");
    const capRow = runbook
      .split("\n")
      .filter((l) => l.includes("PENDING_PROPOSAL_CAP"))
      .join("\n");
    expect(capRow).not.toMatch(/set state = 'rejected'/);
    expect(capRow).toMatch(/set state = 'expired'/);
    expect(capRow, "the retired permanent-429 claim survived").not.toMatch(
      /there is no way to drain this queue/i,
    );
  });

  it("KNOWN-ISSUES' drain entry is amended, and its stale remedy retargeted", () => {
    const ki = read("KNOWN-ISSUES.md");
    // The same sentence, in the very entry that was about it.
    const entry = ki.slice(ki.indexOf("A1 ships an approval queue nothing can drain"));
    const bounded = entry.slice(0, entry.indexOf("\n\n- **", 10));
    expect(bounded).not.toMatch(/set state = 'rejected'/);
    expect(bounded).toMatch(/expired/);
    // All three halves the amendment has to state.
    expect(bounded, "the retired half is not stated").toMatch(/expir/i);
    expect(bounded, "the surviving half is not stated").toMatch(/A0b/);
  });
});

describe("A2/T11: rejected designs are recorded so they cannot quietly return", () => {
  const adr = () => read("docs/adr/approver-identity.md");

  it("the undo / hold-then-send window is recorded as REJECTED", () => {
    expect(adr()).toMatch(/hold-then-send|undo window/i);
    expect(adr()).toMatch(/rejected/i);
  });

  it("the display-binding claim is recorded as deleted, in BOTH its forms", () => {
    // A one-item list did not catch the second form last time: the mechanism was deleted
    // and its SENTENCE survived in the publishable set, which is how a deleted control
    // becomes a published guarantee.
    const t = adr();
    expect(t).toMatch(/byte for byte/i);
    expect(t).toMatch(/rendering we no longer produce/i);
  });

  it("states what A2 does NOT attest", () => {
    const t = adr();
    expect(t).toMatch(/does not attest what (her|the) browser/i);
    expect(t).toMatch(/SMTP envelope/i);
  });
});
