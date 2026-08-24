// voice-invention — post-hoc detection of INVENTED questions in model turns. PURE, no
// vendor imports (the crm containment rule): the worker feeds it transcripts and the
// tracker's attribution; tests feed it the live call's turns verbatim.
//
// THE INCIDENT (2026-08-24, touch 2f7ecfae, /tmp/w-p1.log): on a live call, 3.1 asked
// the owner "are you still thinking of selling your property at 123 Main Street?" (a
// fabricated address) and "do you happen to know your credit score range?" — questions
// `crm.questions` does not contain. On a real call this is soliciting financial
// information the broker never approved, from her leads. Every invention arrived in an
// AUTO-REPLY: a model turn triggered by caller speech that our loop never initiated
// (scripted questions always follow `send-directive`; all three inventions followed
// `transcript-in` with no directive). Dry-socket probes with the real instructions:
// 3.1 invented 4/4, 2.5 invented 0/3 — the model pattern-completing a familiar US
// telemarketing script (credit, budget, buy-or-rent, consent-to-record, "123 Main
// Street") when the loop leaves a gap.
//
// THE BOUNDARY (probe findings, Q4 — the mechanical distinction that held across every
// observed good and bad case): in an unsolicited turn, DECLARATIVE content responding
// to the caller is reciprocity — the owner-praised deferral ("I'm just gathering this
// information for the broker… I'll make sure it gets passed along") contains no
// question and must never flag; an INTERROGATIVE that is not a re-voicing of the
// currently-open approved question is invention. Named, accepted edge: a clarifying
// question about the caller's own words flags too — separating clarify from solicit is
// semantic, not mechanical, and a false SUSPECTED flag costs a log line, nothing more.
//
// 🚨 DETECTION AND LOGGING ONLY. Nothing may branch on a verdict to change call
// behaviour: the 2026-08-23 adversarial review proved that altering interrupt/turn
// handling without a full turn-attribution state machine re-creates the 2026-08-22
// leak-call corruption. The verdicts exist so the call-done summary and the broker's
// report can SAY an unapproved question was voiced — prevention lives in the standing
// instruction (voice-agent-session.ts), which is probabilistic and therefore needs
// exactly this net under it.
//
// KNOWN LIMIT, NAMED: interrogative detection keys on the transcript's own "?" — the
// output transcription is Gemini's transcription OF audio already sent (native audio:
// there is no text-before-speech interception point), and on every observed turn it
// punctuated questions correctly. A transcription that drops the "?" slips the net;
// the net is post-hoc anyway.

/** A model turn as the detector sees it. */
export interface ModelTurnForInventionCheck {
  /** The turn's aggregated output transcription (fragments joined in arrival order). */
  transcript: string;
  /** From `ModelTurnSummary.directivePreceded`: did OUR directive solicit this turn?
   *  True = the loop initiated it (scripted content, governed by the directive
   *  wrapper); false = the auto-reply channel, the only place invention has been
   *  observed. */
  directivePreceded: boolean;
  /** The currently-open approved question, when one is open — re-voicing it (in the
   *  model's own words; SETTLED: substance not verbatim) is legitimate. */
  openQuestion?: string | undefined;
}

export type InventionVerdict =
  | { flagged: false; reason: "solicited" | "no-interrogative" | "re-voicing" | "empty" }
  | { flagged: true; reason: "unsolicited-interrogative"; interrogatives: string[] };

/** Words carrying no question identity — dropped before the overlap test so that
 *  "which areas are you considering?" reduces to {areas, considering} and a re-voicing
 *  in different function words still matches. */
const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "am", "was", "were", "be", "been", "being",
  "do", "does", "did", "have", "has", "had", "will", "would", "can", "could",
  "should", "shall", "may", "might", "must",
  "i", "i'm", "i'll", "you", "your", "yours", "you're", "we", "our", "us",
  "he", "she", "it", "it's", "they", "them", "their",
  "this", "that", "these", "those", "there", "here",
  "to", "of", "in", "on", "at", "for", "with", "from", "by", "about",
  "and", "or", "but", "so", "if", "as", "not", "no",
  "what", "which", "who", "whom", "whose", "how", "when", "where", "why",
  "just", "please", "now", "then", "still", "again", "sorry", "okay", "oh",
  "me", "my", "any", "some", "up", "out",
]);

/** Phrases that make an interrogative a REPEAT REQUEST — asking the caller to say the
 *  same thing again is licensed by the standing instruction ("repeat ≠ new question")
 *  and must not read as invention. */
const REPEAT_REQUEST = /\b(repeat( that)?|say (that|it) again|come again|didn'?t (catch|hear|get) that|hear you)\b/i;

function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9']+/)) {
    if (raw.length > 0 && !STOPWORDS.has(raw)) out.add(raw);
  }
  return out;
}

/** Sentences of `text` that end in a question mark, in order. The "sentence" is
 *  everything since the previous terminator, so "Now, I have another question for you:
 *  Are you still thinking of selling…?" comes back whole. */
export function interrogativesOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[^.!?]+\?/g)) {
    const s = m[0].trim();
    if (s.length > 1) out.push(s);
  }
  return out;
}

/** Is `interrogative` a re-voicing of `openQuestion` — the same substance in possibly
 *  different words? Mechanical test: the interrogative must cover at least half of the
 *  open question's content tokens. Paraphrases that share no content tokens flag as
 *  invention (accepted edge, header) — but every observed legitimate re-ask re-used
 *  the question's own nouns ("Which areas are you considering?" → "which areas were
 *  you considering?"). */
const REVOICING_COVERAGE = 0.5;

function isRevoicing(interrogative: string, openQuestion: string): boolean {
  if (REPEAT_REQUEST.test(interrogative)) return true;
  const q = contentTokens(openQuestion);
  if (q.size === 0) return false; // an all-stopword question cannot anchor the test
  const i = contentTokens(interrogative);
  let covered = 0;
  for (const tok of q) if (i.has(tok)) covered += 1;
  return covered / q.size >= REVOICING_COVERAGE;
}

/** Classify one closed model turn. See the header for the boundary this encodes. */
export function classifyModelTurn(turn: ModelTurnForInventionCheck): InventionVerdict {
  if (turn.directivePreceded) return { flagged: false, reason: "solicited" };
  const transcript = turn.transcript.trim();
  if (transcript.length === 0) return { flagged: false, reason: "empty" };
  const interrogatives = interrogativesOf(transcript);
  if (interrogatives.length === 0) return { flagged: false, reason: "no-interrogative" };
  const open = turn.openQuestion;
  const inventions =
    open === undefined
      ? interrogatives.filter((s) => !REPEAT_REQUEST.test(s))
      : interrogatives.filter((s) => !isRevoicing(s, open));
  if (inventions.length === 0) return { flagged: false, reason: "re-voicing" };
  return { flagged: true, reason: "unsolicited-interrogative", interrogatives: inventions };
}

/** Recover the approved utterance from the directive wrapper (`speakTurnInstruction`
 *  rides it inside double quotes). Undefined when no quoted span exists — the caller
 *  falls back to the whole directive text, which only widens the re-voicing anchor. */
export function extractQuotedUtterance(directiveText: string): string | undefined {
  const first = directiveText.indexOf('"');
  const last = directiveText.lastIndexOf('"');
  if (first === -1 || last <= first) return undefined;
  const inner = directiveText.slice(first + 1, last).trim();
  return inner.length > 0 ? inner : undefined;
}

/**
 * The worker-facing accumulator: fed the same events the worker already handles
 * (directive sends, outputTranscription fragments, turn closes), it joins fragments
 * per turn, tracks the open approved question from the last directive, classifies at
 * each close, and keeps the count for the call-done summary. One instance per call.
 */
export class InventionMonitor {
  private fragments: string[] = [];
  private openQuestion: string | undefined;
  private suspected = 0;

  /** A directive of ours hit the wire; its quoted payload is now the open question. */
  onDirective(directiveText: string): void {
    this.openQuestion = extractQuotedUtterance(directiveText) ?? directiveText;
  }

  /** One outputTranscription fragment (the wire's own spacing is preserved). */
  onOutputFragment(text: string): void {
    this.fragments.push(text);
  }

  /** The turn closed (turnComplete OR interrupted). Classifies what accumulated and
   *  resets for the next turn; undefined when the turn produced no transcript. */
  onTurnClosed(directivePreceded: boolean): InventionVerdict | undefined {
    if (this.fragments.length === 0) return undefined;
    const transcript = this.fragments.join("");
    this.fragments = [];
    const verdict = classifyModelTurn({
      transcript,
      directivePreceded,
      openQuestion: this.openQuestion,
    });
    if (verdict.flagged) this.suspected += 1;
    return verdict;
  }

  /** How many closed turns were SUSPECTED INVENTION — the call-done summary field. */
  suspectedCount(): number {
    return this.suspected;
  }
}
