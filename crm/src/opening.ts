// Core loop / T8+§5.5/§5.6 — the sentence the agent says first.
//
// 🚨 SUBSTITUTION HAPPENS AT PROPOSAL TIME, AND ONLY THERE. The fully-rendered line is what
// she sees on the card and what the immutable payload binds (015:353-363), so SHE APPROVES
// THE EXACT WORDS THAT WILL BE SPOKEN. Nothing is templated at call time; a rendered line
// carrying a leftover `{name}` is a bug the pin below catches.
//
// TWO LINES, BOTH HERS TO EDIT:
//   · `opening_line` — the named path. Contains `{name}`; 016 CHECKs that it does.
//   · `opening_line_no_name` — the nameless path. The agent introduces itself as AN
//     ASSOCIATE OF THE BROKER, using HER name, not the contact's. No placeholder is
//     required and none is invented. 016 CHECKs it is non-blank, because an empty line
//     means the agent opens a nameless call WITH SILENCE.
//
// Owner, rev 4, verbatim: "nope if the number has no name just introduce yourself as an
// associate of the end user." My rev-3 proposal to BLOCK a call for a missing name was
// rejected and is gone. A missing field must never cost her a follow-up — label the
// uncertainty, do not withhold the call.
export interface OpeningLines {
  openingLine: string;
  openingLineNoName: string;
}

export interface RenderedOpening {
  line: string;
  /** Which of her two lines was used. */
  path: "named" | "nameless";
  /**
   * 🚨 A DATA-QUALITY FACT, NOT A DISPOSITION. True only on the nameless path: the answers
   * came from SOMEONE AT THAT NUMBER and we do not know who. `wrong_person` is a different
   * claim entirely — that we ASKED and were told this is not the contact — and 016's CHECK
   * makes the two unrepresentable together.
   */
  identityUnverified: boolean;
}

export function renderOpening(
  displayName: string | null,
  lines: OpeningLines,
): RenderedOpening {
  // `is null`, never `=== ""`. The column is nullable and that is the condition everywhere
  // in this design.
  if (displayName === null) {
    return { line: lines.openingLineNoName, path: "nameless", identityUnverified: true };
  }
  return {
    line: lines.openingLine.replaceAll("{name}", displayName),
    path: "named",
    identityUnverified: false,
  };
}
