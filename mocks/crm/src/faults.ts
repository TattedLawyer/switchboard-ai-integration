import { prng } from "./seed.js";

export type FaultPlan = {
  seed: number;
  dropRate: number;
  dupRate: number;
  apiErrorRate: number;
  // 0..1: fraction of delivered events held back and delivered AFTER the rest of the
  // batch, so delivery order != emission order. Ledger/seq order is never affected.
  shuffleRate?: number;
};
export type DeliveryFate = "deliver" | "drop" | "duplicate";

export function createFaultInjector(plan?: FaultPlan): {
  deliveryFate(): DeliveryFate;
  apiShouldFail(): boolean;
  shouldShuffle(): boolean;
} {
  if (!plan) {
    return {
      deliveryFate: () => "deliver",
      apiShouldFail: () => false,
      shouldShuffle: () => false,
    };
  }

  const rand = prng(plan.seed);

  return {
    deliveryFate(): DeliveryFate {
      const r = rand();
      if (r < plan.dropRate) return "drop";
      if (r < plan.dropRate + plan.dupRate) return "duplicate";
      return "deliver";
    },
    apiShouldFail(): boolean {
      const r = rand();
      return r < plan.apiErrorRate;
    },
    shouldShuffle(): boolean {
      const r = rand();
      return r < (plan.shuffleRate ?? 0);
    },
  };
}
