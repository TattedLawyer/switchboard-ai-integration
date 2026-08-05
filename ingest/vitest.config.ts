import { defineConfig } from "vitest/config";
// 30s tests / 120s hooks: nearly every test here provisions an ephemeral Postgres
// database; the vitest 5s default flakes under machine contention (observed during the
// 2026-07-25 external audit with parallel load, and CI shared runners are the same
// environment). Hooks get the larger bound (Task F, register): sheet-mart-oracle's
// freshTestDb beforeEach blew the 30s hook budget under FULL-SUITE load — a hook
// timeout is pure provisioning contention, never a behavior signal, so starving it
// only manufactures flakes.
// ALLOW_DEV_SECRETS: tests are a dev context — the fail-closed secret gate (A2) may
// serve its published demo defaults here. secrets.test.ts clears the flag per-test to
// prove the closed path.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // PRE-3 (#22): reclaim `switchboard_test_*` databases a SIGKILLed run abandoned.
    // Best-effort by construction — see helpers/global-setup.ts; it can log, it cannot
    // fail the run, and the predicate it delegates to (helpers/sweep-test-dbs.ts) refuses
    // everything it does not positively recognise as ours AND stale.
    globalSetup: ["test/helpers/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // INGEST_SOURCES (PRE-3 #15): the webhook doors are now mounted over the sources a
    // deployment actually serves, so a test that posts to `/webhooks/hubcrm` has to say
    // which deployment it is. Declared ONCE here, as the whole registry, rather than
    // nineteen times across the door/connector suites: "the test deployment serves every
    // registered source" is a single visible fact, and scattering it would make the next
    // source's registration a nineteen-file edit. The door BEHAVIOUR itself is never
    // taken from this default — `test/disabled-source-door.test.ts` passes its enabled
    // set explicitly per case, so enabled/disabled/unregistered are pinned against
    // stated inputs and cannot be quietly satisfied by whatever the environment holds.
    env: {
      ALLOW_DEV_SECRETS: "1",
      INGEST_SOURCES: "crm,billing,support,sheets,stripefeed,hubcrm,casebus",
    },
  },
});
