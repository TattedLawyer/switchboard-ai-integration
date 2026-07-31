import { createHubcrmApp } from "./server.js";

const port = Number(process.env.PORT ?? 4007);
const seed = Number(process.env.SEED ?? 42);
const { app } = createHubcrmApp({
  seed,
  webhookUrl: process.env.WEBHOOK_URL ?? "http://localhost:4002/webhooks/hubcrm",
});
app.listen(port, () => console.log(`mock-hubcrm listening on :${port}`));
