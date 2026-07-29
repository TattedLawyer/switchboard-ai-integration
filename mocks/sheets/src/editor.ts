// The simulated human editor: seeded fault-plan operations applied to the grid.
// Fully deterministic — same seed + same plan + same step count → identical grid,
// journal, and (via onHumanEdit) notification stream.

import type { SheetState } from "./sheet.js";

export const FAULT_PLANS = ["calm", "messy", "bulk", "hostile"] as const;
export type FaultPlanName = (typeof FAULT_PLANS)[number];

// The free-hand garbage a human types. These strings are FORMAT garbage, deliberately
// not manifest content — identity content (names/emails/companies/deals) always comes
// from the manifest universe.
export const FREEHAND_DATES = ["7/30", "July 30", "30-Jul-2026", "tomorrow"] as const;
export const GARBAGE_CURRENCIES = ["usd", "US Dollars", "₱", ""] as const;

export type HumanEdit = {
  step: number;
  op: string;
  range: string;
  /** Deterministic logical clock (base + step seconds), NOT wall clock: byte-identical
   *  replay is a mock requirement. A real onEdit trigger would stamp wall time; the
   *  connector must treat this value as opaque/derived either way. */
  occurred_at: string;
  rowsChanged: number;
};

export type Editor = {
  /** Apply one human edit step under the given plan. Calls onHumanEdit exactly once
   *  per STEP (not per row) — see trigger.ts for why that is the conservative
   *  coalescing encoding. */
  applyStep(plan: FaultPlanName): HumanEdit;
  applySteps(n: number, plan: FaultPlanName): HumanEdit[];
  steps(): number;
};

export function createEditor(
  _sheet: SheetState,
  _opts: { seed: number; onHumanEdit?: (e: HumanEdit) => void },
): Editor {
  throw new Error("not implemented (RED)");
}
