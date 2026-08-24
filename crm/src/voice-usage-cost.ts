// Per-call cost accounting from the Live API's own `usageMetadata` reports.
//
// WHY: the worker logged only `totalTokenCount`, and a total cannot be priced. Live bills
// audio and text ~6x apart, so a total is not a cost — it is an input to a guess. This
// module keeps the wire's modality split intact and turns it into money at a published
// rate card, so "what did that call cost" is answered by observation.
//
// WHAT IT DELIBERATELY DOES NOT DECIDE: whether each `usageMetadata` report restates a
// running session total (CUMULATIVE) or prices one turn (PER-TURN). Google's Live docs say
// only that usage arrives periodically per server turn; they never say which. On call
// bbdf2973 the totals grew monotonically, which is consistent with both readings and which
// differ ~10x for the same call. Guessing here would silently mis-state every cost figure
// we ever quote, so `priceCall` returns BOTH and `monotonic` records what was observed.
// One live call with this in place settles it as a fact.
//
// Caching is unsupported on Live (both model pages say "Not supported"), so there is no
// cached-token tier to model — every token in a report is billed at full rate.

/** Modality names as the API spells them (`ModalityTokenCount.modality`). */
export type ModalityName = string;

/** One `usageMetadata` report, flattened from the wire. All fields optional-by-zero: the
 *  API omits what does not apply, and the real log contains an empty `{}` report. */
export interface UsageSample {
  promptTokens: number;
  responseTokens: number;
  totalTokens: number;
  /** Billed at the OUTPUT rate — the pricing page says output "including thinking tokens". */
  thoughtsTokens: number;
  promptByModality: Record<ModalityName, number>;
  responseByModality: Record<ModalityName, number>;
}

/** Token totals under one reading of the report series. */
export interface UsageTotals {
  promptTokens: number;
  responseTokens: number;
  totalTokens: number;
  thoughtsTokens: number;
  promptByModality: Record<ModalityName, number>;
  responseByModality: Record<ModalityName, number>;
}

export interface AccumulatedUsage {
  /** Every report treated as its own charge (sum of all reports). */
  perTurn: UsageTotals;
  /** The last report treated as already stating the session total. */
  cumulative: UsageTotals;
  /** True when `totalTokens` never decreased across the series — the signature of a running
   *  total, though not proof of one (a per-turn series with a growing prompt looks the same). */
  monotonic: boolean;
  sampleCount: number;
}

/** USD per 1,000,000 tokens, by modality, as published on ai.google.dev/gemini-api/docs/pricing. */
export interface RateCard {
  model: string;
  /** Page revision these figures were read from, so a stale card is visible, not silent. */
  pricingAsOf: string;
  inputPerMillion: Record<ModalityName, number>;
  outputPerMillion: Record<ModalityName, number>;
  /** Output rate applied to `thoughtsTokens`. */
  thoughtsPerMillion: number;
}

// Both cards read from https://ai.google.dev/gemini-api/docs/pricing (page dated 2026-08-13).
// Audio rates are IDENTICAL between the two models; text is where they diverge.
export const RATE_CARD_2_5_NATIVE_AUDIO: RateCard = {
  model: "gemini-2.5-flash-native-audio-preview-12-2025",
  pricingAsOf: "2026-08-13",
  inputPerMillion: { TEXT: 0.5, AUDIO: 3.0, IMAGE: 3.0, VIDEO: 3.0 },
  outputPerMillion: { TEXT: 2.0, AUDIO: 12.0 },
  thoughtsPerMillion: 2.0,
};

export const RATE_CARD_3_1_FLASH_LIVE: RateCard = {
  model: "gemini-3.1-flash-live-preview",
  pricingAsOf: "2026-08-13",
  inputPerMillion: { TEXT: 0.75, AUDIO: 3.0, IMAGE: 1.0, VIDEO: 1.0 },
  outputPerMillion: { TEXT: 4.5, AUDIO: 12.0 },
  thoughtsPerMillion: 4.5,
};

export interface PricedTotals {
  inputUsd: number;
  outputUsd: number;
  totalUsd: number;
}

export interface PricedCall {
  model: string;
  pricingAsOf: string;
  /** Cost if each report is its own charge. */
  perTurn: PricedTotals;
  /** Cost if the last report already states the session total. */
  cumulative: PricedTotals;
  /** Modalities seen on the wire that the rate card has no price for. Loud, never $0. */
  unpricedModalities: ModalityName[];
  /** Tokens sitting in those modalities, under the per-turn reading. */
  unpricedTokens: number;
}

function emptyTotals(): UsageTotals {
  return {
    promptTokens: 0,
    responseTokens: 0,
    totalTokens: 0,
    thoughtsTokens: 0,
    promptByModality: {},
    responseByModality: {},
  };
}

function addInto(target: Record<ModalityName, number>, source: Record<ModalityName, number>): void {
  for (const [modality, count] of Object.entries(source)) {
    target[modality] = (target[modality] ?? 0) + count;
  }
}

function totalsFromSample(s: UsageSample): UsageTotals {
  return {
    promptTokens: s.promptTokens,
    responseTokens: s.responseTokens,
    totalTokens: s.totalTokens,
    thoughtsTokens: s.thoughtsTokens,
    promptByModality: { ...s.promptByModality },
    responseByModality: { ...s.responseByModality },
  };
}

/** Fold a call's usage reports into both readings, preserving the modality split. */
export function accumulateUsage(samples: readonly UsageSample[]): AccumulatedUsage {
  const perTurn = emptyTotals();
  let monotonic = true;
  let previousTotal = -Infinity;

  for (const s of samples) {
    perTurn.promptTokens += s.promptTokens;
    perTurn.responseTokens += s.responseTokens;
    perTurn.totalTokens += s.totalTokens;
    perTurn.thoughtsTokens += s.thoughtsTokens;
    addInto(perTurn.promptByModality, s.promptByModality);
    addInto(perTurn.responseByModality, s.responseByModality);

    // An empty report ({} on the wire) carries no total and must not read as a decrease.
    if (s.totalTokens > 0) {
      if (s.totalTokens < previousTotal) monotonic = false;
      previousTotal = s.totalTokens;
    }
  }

  // The cumulative reading is the last report that actually stated a total.
  let cumulative = emptyTotals();
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const s = samples[i];
    if (s !== undefined && s.totalTokens > 0) {
      cumulative = totalsFromSample(s);
      break;
    }
  }

  return { perTurn, cumulative, monotonic, sampleCount: samples.length };
}

function priceTotals(
  totals: UsageTotals,
  card: RateCard,
  unpriced: Set<ModalityName>,
): { priced: PricedTotals; unpricedTokens: number } {
  let inputUsd = 0;
  let outputUsd = 0;
  let unpricedTokens = 0;

  for (const [modality, count] of Object.entries(totals.promptByModality)) {
    const rate = card.inputPerMillion[modality];
    if (rate === undefined) {
      unpriced.add(modality);
      unpricedTokens += count;
      continue;
    }
    inputUsd += (count / 1_000_000) * rate;
  }

  for (const [modality, count] of Object.entries(totals.responseByModality)) {
    const rate = card.outputPerMillion[modality];
    if (rate === undefined) {
      unpriced.add(modality);
      unpricedTokens += count;
      continue;
    }
    outputUsd += (count / 1_000_000) * rate;
  }

  outputUsd += (totals.thoughtsTokens / 1_000_000) * card.thoughtsPerMillion;

  return {
    priced: { inputUsd, outputUsd, totalUsd: inputUsd + outputUsd },
    unpricedTokens,
  };
}

/** Price a call under BOTH readings of the report series. The caller decides nothing; the
 *  next live call's numbers decide which column is the real bill. */
export function priceCall(totals: AccumulatedUsage, card: RateCard): PricedCall {
  const unpriced = new Set<ModalityName>();
  const perTurn = priceTotals(totals.perTurn, card, unpriced);
  const cumulative = priceTotals(totals.cumulative, card, unpriced);

  return {
    model: card.model,
    pricingAsOf: card.pricingAsOf,
    perTurn: perTurn.priced,
    cumulative: cumulative.priced,
    unpricedModalities: [...unpriced],
    unpricedTokens: perTurn.unpricedTokens,
  };
}
