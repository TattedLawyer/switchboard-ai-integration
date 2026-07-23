import { createBillingApp } from "./server.js";

const port = Number(process.env.PORT ?? 4003);
const app = createBillingApp({
  webhookUrl: process.env.WEBHOOK_URL ?? "http://localhost:4002/webhooks/billing",
  ledgerPath: process.env.LEDGER_PATH ?? "./out/ledger-billing.jsonl",
});
app.listen(port, () => console.log(`mock-billing listening on :${port}`));
