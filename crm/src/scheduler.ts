// Core loop / T13 — the periodic poll.
//
// 🚨 `setInterval`, NOT pg-boss, and this is a correction to a claim rev 1 made. pg-boss was
// never rejected by this repo: `ingest/package.json` pins it, `ingest/src/queue.ts` imports
// it, and `createQueue` runs in the live service. What `ingest/src/main.ts:23-28` rejects is
// `boss.schedule()` AS A CRON SURFACE FOR A PAYLOAD-FREE PERIODIC POLL — which is exactly
// what this is. A job queue earns its keep when there is a payload and real retry
// semantics; "wake up and look" has neither.
//
// The shape is copied from `approval/src/expiry.ts:82-104`, deliberately and not
// approximately:
//   · errors are LOGGED AND NEVER THROWN — a poll that dies must not take the process with
//     it, and the enforcement points that do not depend on this process are what make that
//     safe;
//   · the timer is `unref`'d, so the scheduler alone never holds the process open;
//   · it returns a stop function.
export const CYCLE_INTERVAL_MS = 60_000;

/** How many contacts one cycle claims. Bounded so a backlog cannot become one enormous
 *  burst of cards nobody can triage — the same reasoning as A2's pending cap. */
export const CYCLE_BATCH = 25;

export function startScheduler(
  runOnce: () => Promise<unknown>,
  intervalMs: number = CYCLE_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    void runOnce().catch((err) => {
      // NEVER rethrown. An unhandled rejection out of a timer callback is a process kill,
      // and losing the whole proposer because one cycle hit a bad row is strictly worse
      // than losing that cycle: the next tick is sixty seconds away and the claim lease
      // makes the lost work re-claimable in fifteen minutes.
      console.error("[crm] follow-up cycle failed (the next tick retries):", err);
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
