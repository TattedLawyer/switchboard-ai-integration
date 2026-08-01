// Strict boot-time env parsing (debt-burn B1). Hand-rolled envalid semantics — validate
// at boot, throw on invalid, error names the variable — chosen over adopting the library
// because the surface is a handful of scalar vars and the repo's zero-new-dependency
// bias is a standing constraint (research §B1; primary sources: Node process docs — env
// values are always strings; Node timers doc — a NaN/out-of-range delay "will be set to
// 1", i.e. a typo'd interval silently becomes a ~1ms hot loop).
//
// Semantics shared by both parsers:
//   - unset OR empty string → the default (Number("") is 0, one of the exact foot-guns
//     this module exists to remove — empty is treated as absent, never parsed)
//   - present and invalid → throw at boot. The error text is an OPERATOR SURFACE: it
//     names the variable, echoes the rejected value, and states what would be accepted.
//     Wording is pinned in test/config.test.ts — change it deliberately.

/** Integer env var with an inclusive range. Rejects non-integers, NaN, and out-of-range. */
export function intFromEnv(
  name: string,
  fallback: number,
  opts: { min: number; max: number },
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < opts.min || value > opts.max) {
    throw new Error(
      `invalid ${name} "${raw}": must be an integer between ${opts.min} and ${opts.max}`,
    );
  }
  return value;
}

/** Whitelisted string env var. Case-insensitive (values are lowercased before matching,
 *  preserving the pre-B1 tolerance for INGEST_ROLE=Receiver). Rejects anything else. */
export function choiceFromEnv<T extends string>(
  name: string,
  fallback: T,
  choices: readonly T[],
  env: NodeJS.ProcessEnv = process.env,
): T {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = raw.toLowerCase();
  if (!(choices as readonly string[]).includes(value)) {
    throw new Error(`invalid ${name} "${raw}": must be one of ${choices.join(", ")}`);
  }
  return value as T;
}

/** setInterval's documented usable range: Node clamps delays <1, >2147483647, or NaN
 *  to 1ms — so this bound is where "big interval" turns into "hot loop". */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
