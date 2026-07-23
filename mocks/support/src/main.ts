import { createSupportApp } from "./server.js";

const port = Number(process.env.PORT ?? 4004);
const app = createSupportApp({
  webhookUrl: process.env.WEBHOOK_URL ?? "http://localhost:4002/webhooks/support",
  ledgerPath: process.env.LEDGER_PATH ?? "./out/ledger-support.jsonl",
});
app.listen(port, () => console.log(`mock-support listening on :${port}`));
