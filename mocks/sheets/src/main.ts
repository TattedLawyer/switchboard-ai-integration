import { createSheetsApp } from "./server.js";

const port = Number(process.env.PORT ?? 4005);
const { app } = createSheetsApp({
  seed: Number(process.env.SEED ?? 42),
  webhookUrl: process.env.WEBHOOK_URL, // unset → no trigger installed (default posture)
});
app.listen(port, () => console.log(`mock-sheets listening on :${port}`));
