import { prng } from "./seed.js";

export type FaultPlan = { seed: number; dropRate: number; dupRate: number; apiErrorRate: number };
export type DeliveryFate = "deliver" | "drop" | "duplicate";

export function createFaultInjector(plan?: FaultPlan): {
  deliveryFate(): DeliveryFate;
  apiShouldFail(): boolean;
} {
  if (!plan) {
    return {
      deliveryFate: () => "deliver",
      apiShouldFail: () => false,
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
  };
}
