/**
 * Hermetic child-process environment for CLI-spawning tests.
 *
 * WHY THIS EXISTS (recurrence, 2026-08): every CLI-spawning test in this directory used
 * to build the child env as `{ ...process.env, <explicit vars> }`. That spread hands the
 * child WHATEVER the developer's shell or `.env` holds — and when voice work legitimately
 * added `SWITCHBOARD_TENANT_ID` to `.env`, every spawned CLI silently resolved THAT
 * tenant (`resolveDeploymentTenant`, src/config.ts) while the parent test asserted
 * against the all-zeros default tenant: 23 failures across 5 files, all environmental.
 *
 * The first "fix" for this hazard was a register note saying "do not add the variable to
 * `.env`". A note is not a control — the variable was added for a legitimate reason and
 * the note did nothing. So the control is now structural: the child env is built from
 * NOTHING but this allowlist, and a credential or tenant the parent process holds cannot
 * leak in by omission. (Same shape as agent/test/writer-boundary.test.ts's bootChild,
 * which is the in-repo precedent and passes in CI.)
 *
 * Node semantics relied on: an explicit `env` option does NOT inherit the parent env,
 * and keys whose value is `undefined` are ignored — so `...overrides` with an undefined
 * member simply omits it. https://nodejs.org/api/child_process.html
 *
 * `overrides` come LAST on purpose: a test that MEANS to exercise a non-default tenant
 * (pull-tenant.test.ts, tenant-blind-queries.test.ts) passes SWITCHBOARD_TENANT_ID
 * explicitly and it wins — deliberate configuration stays possible; ambient leakage does
 * not. PATH and HOME are the only inherited vars: PATH so `node`/`npx`/`tsx` resolve,
 * HOME for tool caches (tsx) and ~/.pgpass-style auth.
 *
 * The behavioural pin for this contract lives in test/child-env.test.ts — if you change
 * this helper, that file is the proof it still holds.
 */
export function cliEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ...overrides,
  };
}
