// Real per-call cost accounting from the Live API's own usage reports (U1–U8).
//
// WHY THIS EXISTS: the worker logged only `totalTokenCount`, and a total cannot be priced.
// Live bills AUDIO and TEXT at rates that differ ~6x ($3.00/$12.00 per 1M audio in/out vs
// $0.50/$2.00 text on 2.5), so the same 3,532-token call can differ 6x in cost depending on
// the mix. Every "cost per call" number produced without the modality split is an estimate
// wearing a disguise. This module turns the wire's own numbers into money.
//
// THE OPEN QUESTION THIS MODULE REFUSES TO GUESS: on call bbdf2973 the reported totals grew
// monotonically (735, 901, 1054 ... 3532, avg +165/turn). That is consistent with TWO
// readings which differ by ~10x on the same call:
//   · CUMULATIVE — each report restates the session's running total; the call cost is the
//     LAST report (3,532 tokens).
//   · PER-TURN   — each report prices one turn whose prompt re-sends the growing context;
//     the call cost is the SUM of every report (38,337 tokens).
// The Live docs are silent on which (they say only that usageMetadata arrives periodically
// per server turn), and caching is unsupported on Live so there is no discount either way.
// So `priceCall` computes BOTH and reports them side by side: one live call with this
// logging in place settles it by observation instead of by argument.
import { describe, it, expect } from "vitest";
import {
  accumulateUsage,
  priceCall,
  RATE_CARD_2_5_NATIVE_AUDIO,
  RATE_CARD_3_1_FLASH_LIVE,
  type UsageSample,
} from "../src/voice-usage-cost.js";

/** A sample shaped exactly like the wire's `usageMetadata` (modality names are the API's). */
function sample(over: Partial<UsageSample> = {}): UsageSample {
  return {
    promptTokens: 0,
    responseTokens: 0,
    totalTokens: 0,
    thoughtsTokens: 0,
    promptByModality: {},
    responseByModality: {},
    ...over,
  };
}

describe("voice usage cost accounting", () => {
  // U1 — the whole point: audio and text are separated, because they are priced apart.
  it("U1 keeps audio and text token counts distinct rather than collapsing to a total", () => {
    const totals = accumulateUsage([
      sample({
        promptTokens: 1_000,
        responseTokens: 500,
        totalTokens: 1_500,
        promptByModality: { AUDIO: 900, TEXT: 100 },
        responseByModality: { AUDIO: 500 },
      }),
    ]);

    expect(totals.perTurn.promptByModality.AUDIO).toBe(900);
    expect(totals.perTurn.promptByModality.TEXT).toBe(100);
    expect(totals.perTurn.responseByModality.AUDIO).toBe(500);
    // A total alone is unpriceable — it must not be the only thing surviving accumulation.
    expect(totals.perTurn.responseByModality.TEXT ?? 0).toBe(0);
  });

  // U2 — both readings of the growth curve are computed; neither is assumed.
  it("U2 reports the cumulative and per-turn readings side by side", () => {
    const samples = [
      sample({ totalTokens: 735, promptTokens: 700, promptByModality: { AUDIO: 700 } }),
      sample({ totalTokens: 901, promptTokens: 860, promptByModality: { AUDIO: 860 } }),
      sample({ totalTokens: 1_054, promptTokens: 1_000, promptByModality: { AUDIO: 1_000 } }),
    ];
    const totals = accumulateUsage(samples);

    // Cumulative reading: the last report already states the session total.
    expect(totals.cumulative.totalTokens).toBe(1_054);
    // Per-turn reading: every report is its own charge.
    expect(totals.perTurn.totalTokens).toBe(735 + 901 + 1_054);
    // And the module says which it OBSERVED, without deciding the billing question.
    expect(totals.monotonic).toBe(true);
    expect(totals.sampleCount).toBe(3);
  });

  // U3 — a non-monotonic series is the observation that settles it the other way.
  it("U3 flags a non-monotonic series (per-turn reports, not a running total)", () => {
    const totals = accumulateUsage([
      sample({ totalTokens: 900 }),
      sample({ totalTokens: 120 }),
      sample({ totalTokens: 340 }),
    ]);
    expect(totals.monotonic).toBe(false);
  });

  // U4 — money. Hand-computed against the published rate card, not a round trip through
  // the implementation's own arithmetic.
  it("U4 prices audio and text at their separate published rates", () => {
    const totals = accumulateUsage([
      sample({
        promptTokens: 1_000_000,
        responseTokens: 1_000_000,
        promptByModality: { AUDIO: 1_000_000 },
        responseByModality: { AUDIO: 1_000_000 },
      }),
    ]);
    const priced = priceCall(totals, RATE_CARD_2_5_NATIVE_AUDIO);

    // Exactly 1M audio in ($3.00) + 1M audio out ($12.00).
    expect(priced.perTurn.inputUsd).toBeCloseTo(3.0, 6);
    expect(priced.perTurn.outputUsd).toBeCloseTo(12.0, 6);
    expect(priced.perTurn.totalUsd).toBeCloseTo(15.0, 6);
  });

  // U5 — the rate cards differ where the docs say they differ, and match where they match.
  it("U5 prices 3.1 text higher than 2.5 while audio stays identical", () => {
    const textHeavy = accumulateUsage([
      sample({
        promptTokens: 1_000_000,
        responseTokens: 1_000_000,
        promptByModality: { TEXT: 1_000_000 },
        responseByModality: { TEXT: 1_000_000 },
      }),
    ]);
    const audioOnly = accumulateUsage([
      sample({
        promptTokens: 1_000_000,
        responseTokens: 1_000_000,
        promptByModality: { AUDIO: 1_000_000 },
        responseByModality: { AUDIO: 1_000_000 },
      }),
    ]);

    const text25 = priceCall(textHeavy, RATE_CARD_2_5_NATIVE_AUDIO).perTurn;
    const text31 = priceCall(textHeavy, RATE_CARD_3_1_FLASH_LIVE).perTurn;
    // 2.5: $0.50 in + $2.00 out. 3.1: $0.75 in + $4.50 out.
    expect(text25.totalUsd).toBeCloseTo(2.5, 6);
    expect(text31.totalUsd).toBeCloseTo(5.25, 6);

    const audio25 = priceCall(audioOnly, RATE_CARD_2_5_NATIVE_AUDIO).perTurn;
    const audio31 = priceCall(audioOnly, RATE_CARD_3_1_FLASH_LIVE).perTurn;
    expect(audio31.totalUsd).toBeCloseTo(audio25.totalUsd, 6);
  });

  // U6 — thinking tokens bill at the OUTPUT rate, and 3.1's output rate is 2.25x 2.5's.
  // Omitting them would under-report every call on a model with thinking enabled.
  it("U6 bills thoughts tokens at the output rate", () => {
    const totals = accumulateUsage([sample({ thoughtsTokens: 1_000_000 })]);
    expect(priceCall(totals, RATE_CARD_2_5_NATIVE_AUDIO).perTurn.outputUsd).toBeCloseTo(2.0, 6);
    expect(priceCall(totals, RATE_CARD_3_1_FLASH_LIVE).perTurn.outputUsd).toBeCloseTo(4.5, 6);
  });

  // U7 — a modality the rate card has no price for must be VISIBLE, not silently dropped
  // into $0. If Google adds a modality (or renames one), the cost figure would quietly
  // under-report forever; this makes that a loud gap instead. TEXT/AUDIO/IMAGE/VIDEO are
  // all priced on both cards, so this uses a name no card carries.
  it("U7 surfaces unpriced modalities instead of pricing them as free", () => {
    const totals = accumulateUsage([
      sample({ promptTokens: 500, promptByModality: { MODALITY_UNSPECIFIED: 500 } }),
    ]);
    const priced = priceCall(totals, RATE_CARD_2_5_NATIVE_AUDIO);
    expect(priced.unpricedModalities).toContain("MODALITY_UNSPECIFIED");
    expect(priced.unpricedTokens).toBe(500);
  });

  // U7b — and the modalities a phone call actually uses ARE priced on both cards, so U7
  // cannot pass by the card simply being empty.
  it("U7b prices every modality a call can produce on both rate cards", () => {
    for (const card of [RATE_CARD_2_5_NATIVE_AUDIO, RATE_CARD_3_1_FLASH_LIVE]) {
      const totals = accumulateUsage([
        sample({
          promptByModality: { AUDIO: 10, TEXT: 10 },
          responseByModality: { AUDIO: 10, TEXT: 10 },
        }),
      ]);
      expect(priceCall(totals, card).unpricedModalities).toEqual([]);
    }
  });

  // U8 — an empty or absent report (the wire sends `{}`) must not corrupt the accounting.
  // The real log contains exactly one such line.
  it("U8 tolerates empty usage reports", () => {
    const totals = accumulateUsage([sample(), sample({ totalTokens: 100 })]);
    expect(totals.perTurn.totalTokens).toBe(100);
    expect(totals.sampleCount).toBe(2);
    expect(() => priceCall(totals, RATE_CARD_2_5_NATIVE_AUDIO)).not.toThrow();
  });
});
