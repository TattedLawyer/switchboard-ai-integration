import { mkdirSync, writeFileSync } from "node:fs";
import pg from "pg";
import { generateMondayReport } from "./report.js";
import { pickLlm } from "./llm.js";
import { agentConnectionString } from "./agent-db.js";

// Read-only role, enforced by Postgres — see agent-db.ts and test/db-privileges.test.ts.
const pool = new pg.Pool({ connectionString: agentConnectionString() });
const md = await generateMondayReport(pool, pickLlm());
mkdirSync("out", { recursive: true });
writeFileSync("out/monday-report.md", md, "utf8");
console.log("wrote out/monday-report.md");
await pool.end();
