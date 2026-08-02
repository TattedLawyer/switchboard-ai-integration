import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type pg from "pg";

// Wave-5 bound emission (Task G): warehouse/seeds/numeric_bounds.csv is the ONE dbt-side
// rendering of the numeric contract's quantitative bounds, emitted from
// ingest/src/numeric-contract.ts by scripts/generate-numeric-bounds-seed.ts. Test
// fixtures load THIS committed file — never a re-typed copy — so a fixture can only
// disagree with dbt by the seed being stale, and staleness is exactly what the
// consistency pin in numeric-bounds-seed.test.ts reds.
export const NUMERIC_BOUNDS_SEED_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../warehouse/seeds/numeric_bounds.csv",
);

export const NUMERIC_BOUNDS_HEADER = "event_type,field,plausible_max,scale_min,scale_max";

export interface NumericBoundsSeedRow {
  event_type: string;
  field: string;
  plausible_max: number | null;
  scale_min: number | null;
  scale_max: number | null;
}

export function readNumericBoundsSeed(): NumericBoundsSeedRow[] {
  if (!existsSync(NUMERIC_BOUNDS_SEED_PATH)) {
    throw new Error(
      "warehouse/seeds/numeric_bounds.csv is not emitted — run `npx tsx scripts/generate-numeric-bounds-seed.ts` and commit the diff",
    );
  }
  const [header, ...lines] = readFileSync(NUMERIC_BOUNDS_SEED_PATH, "utf8").trim().split("\n");
  if (header !== NUMERIC_BOUNDS_HEADER) {
    throw new Error(`numeric_bounds.csv header drifted: ${header}`);
  }
  const num = (s: string): number | null => (s === "" ? null : Number(s));
  return lines.map((line) => {
    const cells = line.split(",");
    if (cells.length !== 5) throw new Error(`numeric_bounds.csv row is not 5 cells: ${line}`);
    return {
      event_type: cells[0],
      field: cells[1],
      plausible_max: num(cells[2]),
      scale_min: num(cells[3]),
      scale_max: num(cells[4]),
    };
  });
}

/** Materialize the committed seed as a relation, for tests running REAL warehouse SQL
 *  that refs numeric_bounds. Same column types the seed schema declares to dbt. */
export async function createNumericBoundsFixture(pool: pg.Pool, table = "numeric_bounds"): Promise<void> {
  await pool.query(
    `create table ${table} (event_type text not null, field text not null,
       plausible_max bigint, scale_min int, scale_max int)`,
  );
  for (const r of readNumericBoundsSeed()) {
    await pool.query(`insert into ${table} values ($1, $2, $3, $4, $5)`, [
      r.event_type,
      r.field,
      r.plausible_max,
      r.scale_min,
      r.scale_max,
    ]);
  }
}
