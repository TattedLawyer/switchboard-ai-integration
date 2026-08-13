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

/**
 * 🚨 `keepAlive` EXISTS BECAUSE THE UNREF IS ONLY CORRECT FOR AN EMBEDDED CALLER.
 *
 * MEASURED on node v24.2.0, not reasoned: a process whose only work is this unref'd timer
 * exits in **0.056s having fired zero ticks**. Adding a `pg.Pool` does not save it — an
 * unqueried pool is lazy and holds nothing (0.101s), and a pool that HAS queried holds the
 * process for exactly `idleTimeoutMillis` (10.1s) and then exits, still without a tick.
 *
 * The unref is right when the scheduler is a passenger in a process kept alive by something
 * else — `approval/src/main.ts` survives on `app.listen`'s ref'd handle, which is why
 * `expiry.ts` can unref safely. A DAEMON whose entire purpose is this loop has no such
 * handle, and signal handlers do not hold the event loop open either. So the caller declares
 * which of the two it is. Default `false` keeps every existing caller byte-identical.
 */
export function startScheduler(
  runOnce: () => Promise<unknown>,
  intervalMs: number = CYCLE_INTERVAL_MS,
  keepAlive = false,
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
  if (!keepAlive) timer.unref?.();
  return () => clearInterval(timer);
}
