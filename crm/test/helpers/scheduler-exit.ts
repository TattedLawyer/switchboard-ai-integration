// A child process for T13's `unref` pin.
//
// It starts the scheduler and then does nothing. If the timer is `unref`'d the process
// EXITS; if it is not, the process runs for ever and the pin times out. That is a real
// independent variable — asserting `timer.hasRef()` in-process would be asserting the
// implementation back at itself.
import { startScheduler } from "../../src/scheduler.js";

startScheduler(async () => {
  /* never runs — the process should be gone first */
}, 60_000);
process.stdout.write("scheduler started\n");
