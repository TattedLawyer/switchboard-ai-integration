import { createStripeFeedApp } from "./server.js";

const port = Number(process.env.PORT ?? 4006);
const seed = Number(process.env.SEED ?? 42);
const { app } = createStripeFeedApp({
  seed,
  // Ordering is undocumented in the researched contract, so the standalone mock ships
  // with the shuffle ON: any connector pointed here that trusts response position is
  // wrong from its first page. Tests construct their own apps and choose per-case.
  shuffle: { seed },
});
app.listen(port, () => console.log(`mock-stripefeed listening on :${port}`));
