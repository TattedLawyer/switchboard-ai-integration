// Wave-5 bound emission (Task G): the numeric contract's quantitative bounds, rendered
// as the dbt seed warehouse/seeds/numeric_bounds.csv — the ONE bridge from L1 (the
// TypeScript contract) to the warehouse layer. Before this, every dbt test repeating a
// bound was a hand-copy with a pointer comment ("nothing mechanically diffs them" —
// KNOWN-ISSUES); now the contract is rendered ONCE, the warehouse joins the seed, and
// the consistency pins in ingest/test/numeric-bounds-seed.test.ts red the suite when the
// committed CSV and the contract disagree in either direction.
//
// Committed-generated-file over build-time emission, deliberately (the free_email_domains
// precedent): warehouse inputs stay reviewable tree state — dbt builds reproduce from a
// checkout alone, a bound change arrives as a reviewable diff, and no dbt invocation
// grows an ordering dependency on node tooling. Run
// `npx tsx scripts/generate-numeric-bounds-seed.ts` and commit the diff.
//
// Emitted grain: one row per (event_type, field) that declares at least one quantitative
// bound — plausibleMax (warn-tier ceiling) or min/max (hard scale). Rules with no such
// bound are deliberately absent: an absent row means "no declared bound", and the
// staging join's null-tolerant flag derivation treats it exactly that way. Sorted by
// (event_type, field) so a pure reordering of the contract table never churns the seed.
import { NUMERIC_CONTRACT } from "./numeric-contract.js";

export const NUMERIC_BOUNDS_CSV_HEADER = "event_type,field,plausible_max,scale_min,scale_max";

export interface NumericBoundRow {
  event_type: string;
  field: string;
  plausible_max: number | null;
  scale_min: number | null;
  scale_max: number | null;
}

export function numericBoundRows(): NumericBoundRow[] {
  const rows: NumericBoundRow[] = [];
  for (const [eventType, contract] of Object.entries(NUMERIC_CONTRACT)) {
    for (const [field, rule] of Object.entries(contract)) {
      if (rule.type === "string") continue; // string rules carry patterns, not bounds
      const plausible = rule.plausibleMax ?? null; // undefined and null both mean "no bound"
      const hasScale = rule.min !== undefined || rule.max !== undefined;
      if (plausible === null && !hasScale) continue;
      rows.push({
        event_type: eventType,
        field,
        plausible_max: plausible,
        scale_min: rule.min ?? null,
        scale_max: rule.max ?? null,
      });
    }
  }
  return rows.sort((a, b) => a.event_type.localeCompare(b.event_type) || a.field.localeCompare(b.field));
}

// Renders without a CSV library on purpose: keys are code-reviewed identifiers and the
// values integers, so the format is trivial — but a key that would need quoting is
// refused LOUDLY here rather than silently corrupting the seed.
export function renderNumericBoundsCsv(): string {
  const cell = (v: string | number | null): string => {
    const s = v === null ? "" : String(v);
    if (/[",\n\r]/.test(s)) {
      throw new Error(`numeric_bounds seed value needs CSV quoting — refusing to emit: ${JSON.stringify(s)}`);
    }
    return s;
  };
  const lines = numericBoundRows().map((r) =>
    [cell(r.event_type), cell(r.field), cell(r.plausible_max), cell(r.scale_min), cell(r.scale_max)].join(","),
  );
  return [NUMERIC_BOUNDS_CSV_HEADER, ...lines].join("\n") + "\n";
}
