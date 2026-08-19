/**
 * The chunker — token-measured, no overlap, split only when the window forces it.
 *
 * WHY NO OVERLAP / NO SLIDING WINDOW: those exist to rescue prose from arbitrary page
 * cuts; a typed listing or policy has no such problem. An entry that fits the model's
 * sequence window is exactly ONE chunk, byte-identical to what she wrote. Only oversized
 * entries split — on blank lines first (the author's own structure), then sentences,
 * then (last resort, e.g. an unbroken token wall) words.
 *
 * 🚨 LENGTH IS MEASURED WITH THE ACTUAL TOKENIZER, NEVER BY CHARACTER COUNT. The model's
 * window is 512 TOKENS and Transformers.js truncates SILENTLY past it; peso amounts,
 * Taglish and URLs tokenize far denser than English prose, so a character heuristic
 * passes exactly the entries the model would half-embed. The budget includes the
 * "passage: " prefix the embedder will prepend AND the tokenizer's special tokens,
 * because that full form is what the model actually sees. Pinned (with the
 * char-under/token-over trap case) in crm/test/kb-chunker.test.ts.
 */
import { MAX_SEQ_TOKENS, PASSAGE_PREFIX } from "./embedder.js";

/** The author's paragraph boundary, preserved through packing so that paragraph-aligned
 *  chunks reassemble to the original text (pinned). */
export const PARAGRAPH_SEPARATOR = "\n\n";

type CountTokens = (text: string) => number;

/** One entry body -> ordered chunk texts. `countTokens` MUST be the real model
 *  tokenizer's count (see loadKbTokenizer / Embedder.countTokens) — that requirement is
 *  the whole design. */
export function chunkEntry(
  text: string,
  countTokens: CountTokens,
  maxTokens: number = MAX_SEQ_TOKENS,
): string[] {
  const fits = (t: string): boolean => countTokens(PASSAGE_PREFIX + t) <= maxTokens;

  if (text.trim().length === 0) return [];
  if (fits(text)) return [text]; // the common case: one authored unit, one chunk

  // Atomic units, each individually within budget, each carrying the separator that
  // joins it to a predecessor inside the same chunk.
  const units: Array<{ t: string; sep: string }> = [];
  for (const para of text.split(PARAGRAPH_SEPARATOR)) {
    if (fits(para)) {
      units.push({ t: para, sep: PARAGRAPH_SEPARATOR });
      continue;
    }
    let first = true;
    for (const sentence of splitSentences(para)) {
      const sep = first ? PARAGRAPH_SEPARATOR : " ";
      first = false;
      if (fits(sentence)) {
        units.push({ t: sentence, sep });
      } else {
        // A single over-window sentence (unbroken token wall): word-level last resort.
        const pieces = hardSplit(sentence, fits);
        units.push(...pieces.map((t, i) => ({ t, sep: i === 0 ? sep : " " })));
      }
    }
  }

  // Greedy packing: keep appending units while the RE-MEASURED candidate still fits —
  // token counts do not add linearly across joins, so the candidate is always re-counted
  // whole, never summed from parts.
  const chunks: string[] = [];
  let current = "";
  for (const u of units) {
    const candidate = current === "" ? u.t : current + u.sep + u.t;
    if (fits(candidate)) {
      current = candidate;
    } else {
      if (current !== "") chunks.push(current);
      current = u.t; // every unit fits alone, by construction above
    }
  }
  if (current !== "") chunks.push(current);

  // The contract, restated as a check: nothing leaves this function over-window. With
  // the construction above this is unreachable; if a refactor breaks that, fail HERE,
  // named — never downstream as a silent truncation.
  for (const c of chunks) {
    if (!fits(c)) {
      throw new Error(
        `kb chunker: produced a chunk of ${countTokens(PASSAGE_PREFIX + c)} tokens against a ` +
          `budget of ${maxTokens} — refusing to emit something the model would silently truncate.`,
      );
    }
  }
  return chunks;
}

/** Sentence boundaries: terminal punctuation (Latin + CJK/ellipsis forms she may paste)
 *  followed by whitespace. A number's internal period ("₱1,234.56") never precedes
 *  whitespace, so amounts do not split. */
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+/).filter((s) => s.length > 0);
}

/** Last resort for a single over-budget sentence: greedy word packing; a single word
 *  that alone exceeds the window (no natural language does; a pasted blob might) is cut
 *  by halving to the largest prefix that fits. */
function hardSplit(text: string, fits: (t: string) => boolean): string[] {
  const out: string[] = [];
  let current = "";
  for (let word of text.split(/\s+/).filter((w) => w.length > 0)) {
    while (!fits(word)) {
      let take = word.length;
      while (take > 1 && !fits(word.slice(0, take))) take = Math.floor(take / 2);
      if (current !== "") {
        out.push(current);
        current = "";
      }
      out.push(word.slice(0, take));
      word = word.slice(take);
      if (word.length === 0) break;
    }
    if (word.length === 0) continue;
    const candidate = current === "" ? word : current + " " + word;
    if (fits(candidate)) {
      current = candidate;
    } else {
      if (current !== "") out.push(current);
      current = word;
    }
  }
  if (current !== "") out.push(current);
  return out;
}
