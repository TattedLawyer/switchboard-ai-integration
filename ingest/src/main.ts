import { getPool } from "./db.js";
import { createIngestApp } from "./server.js";

const pool = getPool();
const port = Number(process.env.PORT ?? 4002);
createIngestApp(pool).listen(port, () => console.log(`ingest listening on :${port}`));
