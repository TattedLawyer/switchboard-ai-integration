import { mkdirSync, writeFileSync } from "node:fs";
import pg from "pg";
import { generateMondayReport } from "./report.js";
import { pickLlm } from "./llm.js";
import { agentConnectionString, assertAgentRole } from "./agent-db.js";

// Read-only role, enforced by Postgres — see agent-db.ts and test/db-privileges.test.ts.
// The role is then CHECKED against the live connection before any work runs: the variable
// being set proves nothing about what it points at, and a full-privilege credential here
// would make every read work perfectly while the published claim quietly became false.
const pool = new pg.Pool({ connectionString: agentConnectionString() });
await assertAgentRole(pool);
const md = await generateMondayReport(pool, pickLlm());
mkdirSync("out", { recursive: true });
writeFileSync("out/monday-report.md", md, "utf8");
console.log("wrote out/monday-report.md");
await pool.end();
