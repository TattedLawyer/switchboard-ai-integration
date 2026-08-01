import { createHubcrmApp } from "./server.js";

const port = Number(process.env.PORT ?? 4007);
const seed = Number(process.env.SEED ?? 42);
const { app } = createHubcrmApp({
  seed,
  webhookUrl: process.env.WEBHOOK_URL ?? "http://localhost:4002/webhooks/hubcrm",
  // F-1c chaos port: the demo/chaos scripts pass an emission-ledger path (the same
  // LEDGER_PATH convention as the 2a mocks); unset = no ledger, as in tests/CI fixture.
  ledgerPath: process.env.LEDGER_PATH,
});
app.listen(port, () => console.log(`mock-hubcrm listening on :${port}`));
