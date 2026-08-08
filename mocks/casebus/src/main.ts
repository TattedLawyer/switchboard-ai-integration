import { createCasebusApp } from "./server.js";

const port = Number(process.env.PORT ?? 4008);
const seed = Number(process.env.SEED ?? 42);
const { app } = createCasebusApp({ seed });
app.listen(port, () => console.log(`mock-casebus listening on :${port}`));
