import { mkdirSync, writeFileSync } from "node:fs";
import pg from "pg";
import { generateMondayReport } from "./report.js";
import { pickLlm } from "./llm.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const md = await generateMondayReport(pool, pickLlm());
mkdirSync("out", { recursive: true });
writeFileSync("out/monday-report.md", md, "utf8");
console.log("wrote out/monday-report.md");
await pool.end();
