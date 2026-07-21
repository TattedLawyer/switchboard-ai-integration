import { createCrmApp } from "./server.js";

const port = Number(process.env.PORT ?? 4001);
const app = createCrmApp({
  webhookUrl: process.env.WEBHOOK_URL ?? "http://localhost:4002/webhooks/crm",
  ledgerPath: process.env.LEDGER_PATH ?? "./out/ledger.jsonl",
});
app.listen(port, () => console.log(`mock-crm listening on :${port}`));
