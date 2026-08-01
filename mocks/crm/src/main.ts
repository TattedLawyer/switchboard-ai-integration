import { createCrmApp } from "./server.js";

const port = Number(process.env.PORT ?? 4001);
const app = createCrmApp({
  webhookUrl: process.env.WEBHOOK_URL ?? "http://localhost:4002/webhooks/crm",
  // B5: per-source convention (ledger-<source>.jsonl) — the bare ledger.jsonl default
  // predated the three-source era and matched no script or sibling.
  ledgerPath: process.env.LEDGER_PATH ?? "./out/ledger-crm.jsonl",
});
app.listen(port, () => console.log(`mock-crm listening on :${port}`));
