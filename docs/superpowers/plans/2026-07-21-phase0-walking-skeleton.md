# Switchboard Phase 0 — Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command (`./scripts/demo.sh`) runs the entire skeleton end-to-end: mock CRM emits seeded events → ingest stores them raw in Postgres → dbt builds one staging model → MCP server exposes one read tool → host worker generates a stub Monday report file.

**Architecture:** npm-workspaces monorepo, all TypeScript except a dockerized dbt sidecar. Mock CRM (Express) writes an append-only JSONL ledger of every event it emits (the future chaos oracle). Ingest is deliberately naive in Phase 0 (no idempotency/outbox — that's Phase 1). The MCP server uses the official TS SDK; the host connects in-process for Phase 0.

**Tech Stack:** Node 22, TypeScript 5 (strict), npm workspaces, vitest, Express 4, pg, zod, @modelcontextprotocol/sdk, @anthropic-ai/sdk, dbt-postgres (Docker), Postgres 16 (Docker), docker compose.

## Global Constraints

- **TDD is mandatory** for all production code; config files (package.json, tsconfig, docker-compose, dbt profiles) are exempt per the coding-skills workflow.
- **Fixture hygiene (hard rule):** synthetic data only — `@example.com` emails, `DEMO-` prefixed names/IDs, no realistic phone/SSN patterns. Task 2 bakes a hygiene test in.
- **All TypeScript** except the dbt sidecar (Python inside Docker only).
- Postgres runs on host port **5433** (avoid clashing with any local Postgres). `DATABASE_URL=postgres://switchboard:switchboard@localhost:5433/switchboard`.
- Raw tables live in schema `raw`; dbt models build into schema `analytics`.
- The demo must work **without** `ANTHROPIC_API_KEY` (deterministic template fallback) so CI and reviewers need no secrets.
- Never commit secrets; `.env` is gitignored, `.env.example` is committed.
- Commit after every green test cycle (`git add` specific files, never `git add -A` once code exists).

## File Structure

```
switchboard/
  package.json                  ← npm workspaces root
  tsconfig.base.json
  docker-compose.yml            ← postgres + dbt services
  .env.example  .gitignore
  scripts/demo.sh               ← Task 8
  mocks/crm/
    package.json  tsconfig.json  vitest.config.ts
    src/seed.ts                 ← deterministic synthetic data (Task 2)
    src/ledger.ts               ← append-only JSONL ledger (Task 3)
    src/server.ts               ← Express app: REST + webhook emitter (Task 3)
    src/main.ts                 ← bin entry
    test/seed.test.ts  test/hygiene.test.ts  test/server.test.ts
  ingest/
    package.json  tsconfig.json  vitest.config.ts
    migrations/001_raw_events.sql
    src/migrate.ts  src/db.ts  src/server.ts  src/main.ts
    test/ingest.integration.test.ts
  warehouse/                    ← dbt project (Task 5)
    dbt_project.yml  profiles.yml
    models/staging/stg_crm__companies.sql
    models/staging/schema.yml
  agent/
    package.json  tsconfig.json  vitest.config.ts
    src/mcp/server.ts           ← MCP server + tool registry (Task 6)
    src/host/report.ts          ← report generator (Task 7)
    src/host/llm.ts             ← LlmClient interface + Anthropic + template impls
    src/host/run-report.ts      ← bin entry
    test/mcp.test.ts  test/action-safety.eval.test.ts  test/report.test.ts
  out/                          ← gitignored; demo writes monday-report.md here
```

---

### Task 1: Repo scaffold, Docker Postgres, smoke test

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `docker-compose.yml`, `.env.example`, `.gitignore`, `ingest/package.json`, `ingest/tsconfig.json`, `ingest/vitest.config.ts`, `ingest/src/db.ts`, `ingest/test/db.integration.test.ts`

**Interfaces:**
- Produces: `getPool(): pg.Pool` from `ingest/src/db.ts` (reads `process.env.DATABASE_URL`, throws `Error("DATABASE_URL is required")` if unset). Root scripts: `npm test`, `npm run build`. Compose service `postgres` on host port 5433.

- [ ] **Step 1: Write config files** (TDD-exempt)

Root `package.json`:
```json
{
  "name": "switchboard",
  "private": true,
  "workspaces": ["mocks/crm", "ingest", "agent"],
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "test": "npm run test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true,
    "outDir": "dist", "rootDir": "src", "declaration": true, "sourceMap": true
  }
}
```

`docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: switchboard
      POSTGRES_PASSWORD: switchboard
      POSTGRES_DB: switchboard
    ports: ["5433:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U switchboard"]
      interval: 2s
      timeout: 2s
      retries: 15
  dbt:
    build: ./warehouse
    profiles: ["tools"]
    environment:
      DBT_HOST: postgres
      DBT_USER: switchboard
      DBT_PASSWORD: switchboard
      DBT_DBNAME: switchboard
    volumes: ["./warehouse:/usr/app"]
    depends_on:
      postgres: { condition: service_healthy }
```
(The `dbt` service's Dockerfile arrives in Task 5; `profiles: ["tools"]` keeps it out of default `docker compose up`.)

`.env.example`:
```
DATABASE_URL=postgres://switchboard:switchboard@localhost:5433/switchboard
LEDGER_PATH=./out/ledger.jsonl
# Optional — demo falls back to a deterministic template without it:
ANTHROPIC_API_KEY=
```

`.gitignore`:
```
node_modules/
dist/
out/
.env
```

`ingest/package.json`:
```json
{
  "name": "@switchboard/ingest",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "migrate": "tsx src/migrate.ts",
    "start": "tsx src/main.ts"
  },
  "dependencies": { "express": "^4.19.0", "pg": "^8.12.0", "zod": "^3.23.0" },
  "devDependencies": {
    "@types/express": "^4.17.21", "@types/node": "^22.0.0", "@types/pg": "^8.11.0",
    "tsx": "^4.19.0", "typescript": "^5.5.0", "vitest": "^2.0.0"
  }
}
```

`ingest/tsconfig.json`:
```json
{ "extends": "../tsconfig.base.json", "include": ["src"] }
```

`ingest/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
```

- [ ] **Step 2: Verify dependency versions are current** (search-first rule)

Run: `npm view express version && npm view pg version && npm view @modelcontextprotocol/sdk version && npm view @anthropic-ai/sdk version && npm view vitest version`
Adjust the `^` ranges above to the actual current majors before `npm install`.

- [ ] **Step 3: Write the failing smoke test**

`ingest/test/db.integration.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { getPool } from "../src/db.js";

describe("db connection", () => {
  it("connects to postgres and selects 1", async () => {
    const pool = getPool();
    const res = await pool.query("select 1 as one");
    expect(res.rows[0].one).toBe(1);
    await pool.end();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `docker compose up -d postgres && npm install && npm test -w ingest`
Expected: FAIL — `Cannot find module '../src/db.js'`

- [ ] **Step 5: Write minimal implementation**

`ingest/src/db.ts`:
```ts
import pg from "pg";

export function getPool(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  return new pg.Pool({ connectionString: url });
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `DATABASE_URL=postgres://switchboard:switchboard@localhost:5433/switchboard npm test -w ingest`
Expected: PASS (1 test)

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.base.json docker-compose.yml .env.example .gitignore ingest package-lock.json
git commit -m "chore: scaffold workspaces, docker postgres, db smoke test"
```

---

### Task 2: Deterministic synthetic seed data + PII hygiene test

**Files:**
- Create: `mocks/crm/package.json`, `mocks/crm/tsconfig.json`, `mocks/crm/vitest.config.ts`, `mocks/crm/src/seed.ts`, `mocks/crm/test/seed.test.ts`, `mocks/crm/test/hygiene.test.ts`

**Interfaces:**
- Produces (from `mocks/crm/src/seed.ts`):
  ```ts
  type Company = { id: string; name: string; domain: string; owner_email: string };
  type Deal = { id: string; company_id: string; name: string; amount_cents: number; status: "open" | "won" | "lost" };
  function generateSeed(seed?: number): { companies: Company[]; deals: Deal[] }  // default seed 42
  ```
  Deterministic: same seed → identical output. 20 companies, 60 deals. IDs `DEMO-C-0001…`/`DEMO-D-0001…`.

- [ ] **Step 1: Write config files** (TDD-exempt)

`mocks/crm/package.json`:
```json
{
  "name": "@switchboard/mock-crm",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "start": "tsx src/main.ts"
  },
  "dependencies": { "express": "^4.19.0", "zod": "^3.23.0" },
  "devDependencies": {
    "@types/express": "^4.17.21", "@types/node": "^22.0.0",
    "tsx": "^4.19.0", "typescript": "^5.5.0", "vitest": "^2.0.0"
  }
}
```
`mocks/crm/tsconfig.json` and `vitest.config.ts`: identical pattern to Task 1's ingest versions.

- [ ] **Step 2: Write the failing tests**

`mocks/crm/test/seed.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { generateSeed } from "../src/seed.js";

describe("generateSeed", () => {
  it("is deterministic for the same seed", () => {
    expect(generateSeed(42)).toEqual(generateSeed(42));
  });
  it("produces 20 companies and 60 deals with DEMO- ids", () => {
    const { companies, deals } = generateSeed();
    expect(companies).toHaveLength(20);
    expect(deals).toHaveLength(60);
    expect(companies.every((c) => c.id.startsWith("DEMO-C-"))).toBe(true);
    expect(deals.every((d) => d.id.startsWith("DEMO-D-"))).toBe(true);
  });
  it("links every deal to an existing company", () => {
    const { companies, deals } = generateSeed();
    const ids = new Set(companies.map((c) => c.id));
    expect(deals.every((d) => ids.has(d.company_id))).toBe(true);
  });
});
```

`mocks/crm/test/hygiene.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { generateSeed } from "../src/seed.js";

describe("fixture hygiene", () => {
  const blob = JSON.stringify(generateSeed());
  it("uses only example.com emails", () => {
    const emails = blob.match(/[\w.+-]+@[\w.-]+/g) ?? [];
    expect(emails.length).toBeGreaterThan(0);
    expect(emails.every((e) => e.endsWith("@example.com"))).toBe(true);
  });
  it("contains no SSN- or US-phone-shaped strings", () => {
    expect(blob).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
    expect(blob).not.toMatch(/\b\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/);
  });
  it("prefixes every entity name with DEMO", () => {
    const { companies } = generateSeed();
    expect(companies.every((c) => c.name.startsWith("DEMO "))).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm install && npm test -w mocks/crm`
Expected: FAIL — `Cannot find module '../src/seed.js'`

- [ ] **Step 4: Write minimal implementation**

`mocks/crm/src/seed.ts`:
```ts
export type Company = { id: string; name: string; domain: string; owner_email: string };
export type Deal = { id: string; company_id: string; name: string; amount_cents: number; status: "open" | "won" | "lost" };

// mulberry32 PRNG — deterministic, dependency-free
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SECTORS = ["Logistics", "Manufacturing", "Retail", "Consulting", "Media",
  "Freight", "Staffing", "Catering", "Printing", "Security"];
const STATUSES: Deal["status"][] = ["open", "won", "lost"];

export function generateSeed(seed = 42): { companies: Company[]; deals: Deal[] } {
  const rand = prng(seed);
  const pad = (n: number) => String(n).padStart(4, "0");
  const companies: Company[] = Array.from({ length: 20 }, (_, i) => {
    const sector = SECTORS[i % SECTORS.length];
    const slug = `${sector.toLowerCase()}-${i + 1}`;
    return {
      id: `DEMO-C-${pad(i + 1)}`,
      name: `DEMO ${sector} Group ${i + 1}`,
      domain: `${slug}.example.com`,
      owner_email: `owner.${slug}@example.com`,
    };
  });
  const deals: Deal[] = Array.from({ length: 60 }, (_, i) => ({
    id: `DEMO-D-${pad(i + 1)}`,
    company_id: companies[Math.floor(rand() * companies.length)].id,
    name: `DEMO Deal ${i + 1}`,
    amount_cents: Math.floor(rand() * 5_000_000) + 50_000,
    status: STATUSES[Math.floor(rand() * STATUSES.length)],
  }));
  return { companies, deals };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -w mocks/crm`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add mocks/crm package-lock.json
git commit -m "feat: deterministic synthetic CRM seed with PII hygiene tests"
```

---

### Task 3: Mock CRM service — REST, webhook emitter, append-only ledger

**Files:**
- Create: `mocks/crm/src/ledger.ts`, `mocks/crm/src/server.ts`, `mocks/crm/src/main.ts`, `mocks/crm/test/server.test.ts`

**Interfaces:**
- Consumes: `generateSeed()` (Task 2).
- Produces:
  ```ts
  // ledger.ts
  type LedgerEntry = { event_id: string; event_type: string; occurred_at: string; data: unknown };
  function appendToLedger(path: string, entry: LedgerEntry): void   // sync JSONL append
  function readLedger(path: string): LedgerEntry[]
  // server.ts
  function createCrmApp(opts: { webhookUrl: string; ledgerPath: string; seed?: number }): express.Express
  ```
  HTTP surface: `GET /companies?page=N&per_page=M` → `{ items, page, total }`; same for `/deals`; `POST /simulate { count }` → emits `count` webhook events (round-robin `company.updated` / `deal.updated`, data drawn from seed) to `webhookUrl` via `fetch`, appending each to the ledger BEFORE attempting delivery, and returns `{ emitted }`.
  Event shape: `{ event_id: "evt-<seq>", event_type: "company.updated" | "deal.updated", occurred_at: ISO string, data: Company | Deal }`.

- [ ] **Step 1: Write the failing tests**

`mocks/crm/test/server.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import { createCrmApp } from "../src/server.js";
import { readLedger } from "../src/ledger.js";

let dir: string;
let received: unknown[];
let sink: Server;
let sinkUrl: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "crm-test-"));
  received = [];
  const app = express();
  app.use(express.json());
  app.post("/hook", (req, res) => { received.push(req.body); res.sendStatus(200); });
  await new Promise<void>((r) => { sink = app.listen(0, () => r()); });
  const addr = sink.address() as { port: number };
  sinkUrl = `http://127.0.0.1:${addr.port}/hook`;
});
afterEach(() => { sink.close(); rmSync(dir, { recursive: true, force: true }); });

describe("mock CRM", () => {
  it("paginates companies", async () => {
    const crm = createCrmApp({ webhookUrl: sinkUrl, ledgerPath: join(dir, "l.jsonl") });
    const srv = crm.listen(0);
    const port = (srv.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/companies?page=2&per_page=8`);
    const body = await res.json();
    expect(body.total).toBe(20);
    expect(body.items).toHaveLength(8);
    expect(body.items[0].id).toBe("DEMO-C-0009");
    srv.close();
  });

  it("simulate emits webhooks AND ledgers every event first", async () => {
    const ledgerPath = join(dir, "l.jsonl");
    const crm = createCrmApp({ webhookUrl: sinkUrl, ledgerPath });
    const srv = crm.listen(0);
    const port = (srv.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 10 }),
    });
    expect((await res.json()).emitted).toBe(10);
    const ledger = readLedger(ledgerPath);
    expect(ledger).toHaveLength(10);
    expect(received).toHaveLength(10);
    expect(ledger.map((e) => e.event_id)).toEqual(
      (received as { event_id: string }[]).map((e) => e.event_id),
    );
    srv.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w mocks/crm`
Expected: FAIL — `Cannot find module '../src/server.js'`

- [ ] **Step 3: Write minimal implementation**

`mocks/crm/src/ledger.ts`:
```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type LedgerEntry = { event_id: string; event_type: string; occurred_at: string; data: unknown };

export function appendToLedger(path: string, entry: LedgerEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
}

export function readLedger(path: string): LedgerEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
```

`mocks/crm/src/server.ts`:
```ts
import express from "express";
import { z } from "zod";
import { generateSeed } from "./seed.js";
import { appendToLedger, type LedgerEntry } from "./ledger.js";

export function createCrmApp(opts: { webhookUrl: string; ledgerPath: string; seed?: number }): express.Express {
  const { companies, deals } = generateSeed(opts.seed);
  const app = express();
  app.use(express.json());
  let seq = 0;

  const paginate = <T>(items: T[], req: express.Request) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const per = Math.min(100, Math.max(1, Number(req.query.per_page ?? 10)));
    return { items: items.slice((page - 1) * per, page * per), page, total: items.length };
  };

  app.get("/companies", (req, res) => res.json(paginate(companies, req)));
  app.get("/deals", (req, res) => res.json(paginate(deals, req)));

  app.post("/simulate", async (req, res) => {
    const { count } = z.object({ count: z.number().int().min(1).max(1000) }).parse(req.body);
    let emitted = 0;
    for (let i = 0; i < count; i++) {
      const useCompany = i % 2 === 0;
      const entry: LedgerEntry = {
        event_id: `evt-${++seq}`,
        event_type: useCompany ? "company.updated" : "deal.updated",
        occurred_at: new Date().toISOString(),
        data: useCompany ? companies[seq % companies.length] : deals[seq % deals.length],
      };
      appendToLedger(opts.ledgerPath, entry);      // ledger FIRST — it is the oracle
      await fetch(opts.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(entry),
      });
      emitted++;
    }
    res.json({ emitted });
  });

  return app;
}
```

`mocks/crm/src/main.ts`:
```ts
import { createCrmApp } from "./server.js";

const port = Number(process.env.PORT ?? 4001);
const app = createCrmApp({
  webhookUrl: process.env.WEBHOOK_URL ?? "http://localhost:4002/webhooks/crm",
  ledgerPath: process.env.LEDGER_PATH ?? "./out/ledger.jsonl",
});
app.listen(port, () => console.log(`mock-crm listening on :${port}`));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w mocks/crm`
Expected: PASS (8 tests total in workspace)

- [ ] **Step 5: Commit**

```bash
git add mocks/crm/src/ledger.ts mocks/crm/src/server.ts mocks/crm/src/main.ts mocks/crm/test/server.test.ts
git commit -m "feat: mock CRM with pagination, webhook emitter, append-only ledger"
```

---

### Task 4: Ingest service — migration + naive webhook receiver

**Files:**
- Create: `ingest/migrations/001_raw_events.sql`, `ingest/src/migrate.ts`, `ingest/src/server.ts`, `ingest/src/main.ts`, `ingest/test/ingest.integration.test.ts`

**Interfaces:**
- Consumes: `getPool()` (Task 1); webhook event shape from Task 3.
- Produces: table `raw.raw_crm_events(id bigserial PK, event_id text, event_type text, payload jsonb, received_at timestamptz default now())`; `createIngestApp(pool: pg.Pool): express.Express` with `POST /webhooks/crm` → 202 `{ stored: true }`; `runMigrations(pool): Promise<void>`. *Phase 0 is deliberately naive: duplicates are stored as-is (idempotency is Phase 1).*

- [ ] **Step 1: Write migration + failing integration test**

`ingest/migrations/001_raw_events.sql`:
```sql
create schema if not exists raw;
create table if not exists raw.raw_crm_events (
  id bigserial primary key,
  event_id text not null,
  event_type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now()
);
```

`ingest/test/ingest.integration.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { getPool } from "../src/db.js";
import { runMigrations } from "../src/migrate.js";
import { createIngestApp } from "../src/server.js";

let pool: pg.Pool;

beforeAll(async () => {
  pool = getPool();
  await runMigrations(pool);
  await pool.query("truncate raw.raw_crm_events");
});
afterAll(async () => { await pool.end(); });

describe("ingest webhook", () => {
  it("stores a CRM event as raw jsonb", async () => {
    const app = createIngestApp(pool);
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    const event = {
      event_id: "evt-1",
      event_type: "company.updated",
      occurred_at: new Date().toISOString(),
      data: { id: "DEMO-C-0001", name: "DEMO Retail Group 1", domain: "retail-1.example.com" },
    };
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/crm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    expect(res.status).toBe(202);
    const rows = await pool.query("select event_id, event_type, payload from raw.raw_crm_events");
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].event_id).toBe("evt-1");
    expect(rows.rows[0].payload.data.id).toBe("DEMO-C-0001");
    srv.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgres://switchboard:switchboard@localhost:5433/switchboard npm test -w ingest`
Expected: FAIL — `Cannot find module '../src/migrate.js'`

- [ ] **Step 3: Write minimal implementation**

`ingest/src/migrate.ts`:
```ts
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type pg from "pg";
import { getPool } from "./db.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export async function runMigrations(pool: pg.Pool): Promise<void> {
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    await pool.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pool = getPool();
  runMigrations(pool).then(() => { console.log("migrated"); return pool.end(); });
}
```

`ingest/src/server.ts`:
```ts
import express from "express";
import { z } from "zod";
import type pg from "pg";

const eventSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  occurred_at: z.string(),
  data: z.record(z.unknown()),
});

export function createIngestApp(pool: pg.Pool): express.Express {
  const app = express();
  app.use(express.json());
  app.post("/webhooks/crm", async (req, res) => {
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid event" });
    await pool.query(
      "insert into raw.raw_crm_events (event_id, event_type, payload) values ($1, $2, $3)",
      [parsed.data.event_id, parsed.data.event_type, JSON.stringify(parsed.data)],
    );
    res.status(202).json({ stored: true });
  });
  return app;
}
```

`ingest/src/main.ts`:
```ts
import { getPool } from "./db.js";
import { createIngestApp } from "./server.js";

const pool = getPool();
const port = Number(process.env.PORT ?? 4002);
createIngestApp(pool).listen(port, () => console.log(`ingest listening on :${port}`));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `DATABASE_URL=postgres://switchboard:switchboard@localhost:5433/switchboard npm test -w ingest`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add ingest/migrations ingest/src/migrate.ts ingest/src/server.ts ingest/src/main.ts ingest/test/ingest.integration.test.ts
git commit -m "feat: naive ingest webhook receiver with raw event storage"
```

---

### Task 5: dbt sidecar — one staging model with tests

**Files:**
- Create: `warehouse/Dockerfile`, `warehouse/dbt_project.yml`, `warehouse/profiles.yml`, `warehouse/models/staging/stg_crm__companies.sql`, `warehouse/models/staging/schema.yml`

**Interfaces:**
- Consumes: `raw.raw_crm_events` (Task 4).
- Produces: view `analytics.stg_crm__companies(company_id, name, domain, last_event_at)` — latest state per company. Run via `docker compose run --rm dbt build`; dbt's own tests are the task's tests (dbt is config/SQL — the test-first step is the schema.yml tests failing before the model exists).

- [ ] **Step 1: Write config** (TDD-exempt)

`warehouse/Dockerfile`:
```dockerfile
FROM python:3.12-slim
RUN pip install --no-cache-dir dbt-postgres
WORKDIR /usr/app
ENV DBT_PROFILES_DIR=/usr/app
ENTRYPOINT ["dbt"]
```

Verify the current dbt-postgres install method before building:
Run: `docker run --rm python:3.12-slim pip index versions dbt-postgres`
(Pin the printed latest version in the Dockerfile: `dbt-postgres==<version>`.)

`warehouse/dbt_project.yml`:
```yaml
name: switchboard
version: "1.0.0"
profile: switchboard
model-paths: ["models"]
models:
  switchboard:
    staging:
      +materialized: view
      +schema: analytics
```

`warehouse/profiles.yml`:
```yaml
switchboard:
  target: dev
  outputs:
    dev:
      type: postgres
      host: "{{ env_var('DBT_HOST', 'localhost') }}"
      port: 5432
      user: "{{ env_var('DBT_USER', 'switchboard') }}"
      password: "{{ env_var('DBT_PASSWORD', 'switchboard') }}"
      dbname: "{{ env_var('DBT_DBNAME', 'switchboard') }}"
      schema: public
      threads: 4
```
Note: dbt's `+schema: analytics` yields schema `public_analytics` by default; that is acceptable for Phase 0 — downstream code (Task 6) reads the schema name from `DBT_SCHEMA` env var, default `public_analytics`.

- [ ] **Step 2: Write the model's tests first**

`warehouse/models/staging/schema.yml`:
```yaml
version: 2
models:
  - name: stg_crm__companies
    columns:
      - name: company_id
        tests: [unique, not_null]
      - name: name
        tests: [not_null]
```

- [ ] **Step 3: Run dbt to verify failure**

Run: `docker compose build dbt && docker compose run --rm dbt build`
Expected: FAIL — model `stg_crm__companies` not found (schema.yml references a missing model)

- [ ] **Step 4: Write the model**

`warehouse/models/staging/stg_crm__companies.sql`:
```sql
with company_events as (
    select payload, received_at
    from raw.raw_crm_events
    where event_type like 'company.%'
),
latest as (
    select distinct on (payload -> 'data' ->> 'id')
        payload -> 'data' as company,
        received_at
    from company_events
    order by payload -> 'data' ->> 'id', received_at desc
)
select
    company ->> 'id'     as company_id,
    company ->> 'name'   as name,
    company ->> 'domain' as domain,
    received_at          as last_event_at
from latest
```

- [ ] **Step 5: Seed events and run dbt to verify pass**

Run (from repo root, with mock + ingest running per Task 3/4 `start` scripts, or re-run after Task 8 wires it):
```bash
docker compose run --rm dbt build
```
Expected: `Completed successfully` — 1 model built, 3 tests passed. (If `raw.raw_crm_events` is empty, tests still pass on zero rows.)

- [ ] **Step 6: Commit**

```bash
git add warehouse
git commit -m "feat: dbt sidecar with stg_crm__companies staging model and tests"
```

---

### Task 6: MCP server with one read tool

**Files:**
- Create: `agent/package.json`, `agent/tsconfig.json`, `agent/vitest.config.ts`, `agent/src/mcp/server.ts`, `agent/test/mcp.test.ts`

**Interfaces:**
- Consumes: `analytics` schema view (Task 5); `pg.Pool`.
- Produces:
  ```ts
  // agent/src/mcp/server.ts
  const READ_TOOLS = ["get_account_health"] as const;
  function createMcpServer(pool: pg.Pool): McpServer
  ```
  Tool `get_account_health({ company_id: string })` → JSON text content: `{ company_id, name, domain, last_event_at }` from `stg_crm__companies`, or `isError: true` with message `"company not found"`. Schema name from `process.env.DBT_SCHEMA ?? "public_analytics"`.

- [ ] **Step 1: Write config** (TDD-exempt)

`agent/package.json`:
```json
{
  "name": "@switchboard/agent",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "report": "tsx src/host/run-report.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.57.0",
    "@modelcontextprotocol/sdk": "^1.17.0",
    "pg": "^8.12.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0", "@types/pg": "^8.11.0",
    "tsx": "^4.19.0", "typescript": "^5.5.0", "vitest": "^2.0.0"
  }
}
```
`agent/tsconfig.json` / `vitest.config.ts`: same pattern as Task 1.

Verify SDK APIs before coding (they move fast):
Run: `npm view @modelcontextprotocol/sdk version && npm view @anthropic-ai/sdk version`
Then skim `node_modules/@modelcontextprotocol/sdk/README.md` after install — the plan below uses `McpServer.registerTool`, `InMemoryTransport.createLinkedPair()`, and `Client` from `client/index.js`; adjust imports if the installed major differs.

- [ ] **Step 2: Write the failing test**

`agent/test/mcp.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";

const SCHEMA = process.env.DBT_SCHEMA ?? "public_analytics";
let pool: pg.Pool;
let client: Client;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  // The MCP test provisions its own fixture view so it doesn't depend on dbt having run:
  await pool.query(`create schema if not exists ${SCHEMA}`);
  await pool.query(`
    create or replace view ${SCHEMA}.stg_crm__companies as
    select 'DEMO-C-0001'::text as company_id, 'DEMO Retail Group 1'::text as name,
           'retail-1.example.com'::text as domain, now() as last_event_at
  `);
  const server = createMcpServer(pool);
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTx);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTx);
});
afterAll(async () => { await pool.end(); });

describe("MCP server", () => {
  it("returns account health for a known company", async () => {
    const res = await client.callTool({
      name: "get_account_health",
      arguments: { company_id: "DEMO-C-0001" },
    });
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(JSON.parse(text)).toMatchObject({
      company_id: "DEMO-C-0001",
      name: "DEMO Retail Group 1",
    });
  });

  it("returns isError for an unknown company", async () => {
    const res = await client.callTool({
      name: "get_account_health",
      arguments: { company_id: "DEMO-C-9999" },
    });
    expect(res.isError).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm install && DATABASE_URL=postgres://switchboard:switchboard@localhost:5433/switchboard npm test -w agent`
Expected: FAIL — `Cannot find module '../src/mcp/server.js'`

- [ ] **Step 4: Write minimal implementation**

`agent/src/mcp/server.ts`:
```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type pg from "pg";

export const READ_TOOLS = ["get_account_health"] as const;

export function createMcpServer(pool: pg.Pool): McpServer {
  const schema = process.env.DBT_SCHEMA ?? "public_analytics";
  const server = new McpServer({ name: "switchboard", version: "0.1.0" });

  server.registerTool(
    "get_account_health",
    {
      description: "Look up current health snapshot for one account by company_id.",
      inputSchema: { company_id: z.string().min(1) },
    },
    async ({ company_id }) => {
      const res = await pool.query(
        `select company_id, name, domain, last_event_at from ${schema}.stg_crm__companies where company_id = $1`,
        [company_id],
      );
      if (res.rowCount === 0) {
        return { isError: true, content: [{ type: "text", text: "company not found" }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(res.rows[0]) }] };
    },
  );

  return server;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `DATABASE_URL=postgres://switchboard:switchboard@localhost:5433/switchboard npm test -w agent`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add agent
git commit -m "feat: MCP server with get_account_health read tool"
```

---

### Task 7: Host worker + action-safety eval

**Files:**
- Create: `agent/src/host/llm.ts`, `agent/src/host/report.ts`, `agent/src/host/run-report.ts`
- Test: `agent/test/action-safety.eval.test.ts`, `agent/test/report.test.ts`

**Interfaces:**
- Consumes: `createMcpServer(pool)`, `READ_TOOLS` (Task 6).
- Produces:
  ```ts
  // llm.ts
  interface LlmClient { complete(prompt: string): Promise<string> }
  class TemplateLlm implements LlmClient      // deterministic, no API key needed
  class AnthropicLlm implements LlmClient     // real Claude call, prompt caching on
  function pickLlm(): LlmClient               // Anthropic iff ANTHROPIC_API_KEY set
  // report.ts
  function generateMondayReport(pool: pg.Pool, llm: LlmClient): Promise<string>  // markdown
  ```

- [ ] **Step 1: Write the failing action-safety eval** (this is the Phase 0 eval from the spec)

`agent/test/action-safety.eval.test.ts`:
```ts
import { beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, READ_TOOLS } from "../src/mcp/server.js";

let client: Client;

beforeAll(async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const server = createMcpServer(pool);
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTx);
  client = new Client({ name: "eval", version: "0.0.0" });
  await client.connect(clientTx);
});

describe("action safety (Phase 0 eval)", () => {
  it("exposes exactly the declared read tools — no write surface", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
  });

  it("rejects calls to undeclared (write-shaped) tools", async () => {
    await expect(
      client.callTool({ name: "delete_company", arguments: { company_id: "DEMO-C-0001" } }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run eval to verify current behavior**

Run: `DATABASE_URL=postgres://switchboard:switchboard@localhost:5433/switchboard npm test -w agent`
Expected: PASS immediately (the Task 6 server already satisfies it). That's fine — this eval is a **regression tripwire**: it must exist before any Phase 3 write tool does, so adding one forces a conscious update here.

- [ ] **Step 3: Write the failing report tests**

`agent/test/report.test.ts`:
```ts
import { beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { generateMondayReport } from "../src/host/report.js";
import { TemplateLlm } from "../src/host/llm.js";

const SCHEMA = process.env.DBT_SCHEMA ?? "public_analytics";
let pool: pg.Pool;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(`create schema if not exists ${SCHEMA}`);
  await pool.query(`
    create or replace view ${SCHEMA}.stg_crm__companies as
    select 'DEMO-C-0001'::text as company_id, 'DEMO Retail Group 1'::text as name,
           'retail-1.example.com'::text as domain, now() as last_event_at
  `);
});

describe("Monday report (stub)", () => {
  it("produces markdown naming each company from the unified model", async () => {
    const md = await generateMondayReport(pool, new TemplateLlm());
    expect(md).toContain("# Monday Revenue-Risk Report");
    expect(md).toContain("DEMO Retail Group 1");
    expect(md).toContain("DEMO-C-0001");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `DATABASE_URL=postgres://switchboard:switchboard@localhost:5433/switchboard npm test -w agent`
Expected: FAIL — `Cannot find module '../src/host/report.js'`

- [ ] **Step 5: Write minimal implementation**

`agent/src/host/llm.ts`:
```ts
import Anthropic from "@anthropic-ai/sdk";

export interface LlmClient { complete(prompt: string): Promise<string> }

export class TemplateLlm implements LlmClient {
  async complete(prompt: string): Promise<string> {
    return `_(deterministic template — set ANTHROPIC_API_KEY for narrative)_\n\n${prompt}`;
  }
}

export class AnthropicLlm implements LlmClient {
  private client = new Anthropic();
  async complete(prompt: string): Promise<string> {
    const msg = await this.client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      system: [{
        type: "text",
        text: "You write terse operational reports for a B2B ops team. Data is synthetic demo data.",
        cache_control: { type: "ephemeral" },
      }],
      messages: [{ role: "user", content: prompt }],
    });
    return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }
}

export function pickLlm(): LlmClient {
  return process.env.ANTHROPIC_API_KEY ? new AnthropicLlm() : new TemplateLlm();
}
```
(Verify current model id with `npm view @anthropic-ai/sdk` docs / https://docs.anthropic.com/en/docs/about-claude/models at implementation time.)

`agent/src/host/report.ts` — Phase 0 host loop: list accounts, call the MCP tool for each, hand results to the LLM:
```ts
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../mcp/server.js";
import type { LlmClient } from "./llm.js";

export async function generateMondayReport(pool: pg.Pool, llm: LlmClient): Promise<string> {
  const schema = process.env.DBT_SCHEMA ?? "public_analytics";
  const server = createMcpServer(pool);
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTx);
  const client = new Client({ name: "host", version: "0.1.0" });
  await client.connect(clientTx);

  const ids = await pool.query(`select company_id from ${schema}.stg_crm__companies order by company_id`);
  const snapshots: string[] = [];
  for (const row of ids.rows) {
    const res = await client.callTool({
      name: "get_account_health",
      arguments: { company_id: row.company_id },
    });
    snapshots.push((res.content as { text: string }[])[0].text);
  }

  const narrative = await llm.complete(
    `Summarize account status from these ${snapshots.length} snapshots:\n${snapshots.join("\n")}`,
  );
  return [
    "# Monday Revenue-Risk Report",
    `_Generated ${new Date().toISOString()} · ${snapshots.length} accounts · simulated data_`,
    "",
    narrative,
    "",
    "## Account snapshots",
    ...snapshots.map((s) => `- \`${s}\``),
  ].join("\n");
}
```

`agent/src/host/run-report.ts`:
```ts
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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `DATABASE_URL=postgres://switchboard:switchboard@localhost:5433/switchboard npm test -w agent`
Expected: PASS (5 tests)

- [ ] **Step 7: Commit**

```bash
git add agent/src/host agent/test/action-safety.eval.test.ts agent/test/report.test.ts
git commit -m "feat: host worker generates stub Monday report; action-safety eval tripwire"
```

---

### Task 8: One-command end-to-end demo

**Files:**
- Create: `scripts/demo.sh`, `scripts/check-demo.sh`

**Interfaces:**
- Consumes: everything above via each package's `start`/`migrate`/`report` scripts.
- Produces: `./scripts/demo.sh` → running stack → `out/monday-report.md`; `./scripts/check-demo.sh` exits 0 iff the report exists, is non-empty, and names a `DEMO-C-` company. This pair is the Phase 0 exit criterion.

- [ ] **Step 1: Write the check script first** (it is the test)

`scripts/check-demo.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
f="out/monday-report.md"
[[ -s "$f" ]] || { echo "FAIL: $f missing or empty"; exit 1; }
grep -q "DEMO-C-" "$f" || { echo "FAIL: no DEMO-C- company ids in report"; exit 1; }
grep -q "# Monday Revenue-Risk Report" "$f" || { echo "FAIL: missing report header"; exit 1; }
echo "PASS: end-to-end demo produced a valid report"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `chmod +x scripts/*.sh && ./scripts/check-demo.sh`
Expected: `FAIL: out/monday-report.md missing or empty`, exit 1

- [ ] **Step 3: Write the demo script**

`scripts/demo.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL="${DATABASE_URL:-postgres://switchboard:switchboard@localhost:5433/switchboard}"
export LEDGER_PATH="./out/ledger.jsonl"
rm -f out/monday-report.md out/ledger.jsonl
pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

echo "1/6 postgres up"
docker compose up -d postgres
until docker compose exec postgres pg_isready -U switchboard -q; do sleep 1; done

echo "2/6 migrate"
npm run migrate -w ingest

echo "3/6 start ingest + mock crm"
PORT=4002 npm run start -w ingest & pids+=($!)
PORT=4001 WEBHOOK_URL=http://localhost:4002/webhooks/crm npm run start -w mocks/crm & pids+=($!)
sleep 2

echo "4/6 simulate 50 events"
curl -sf -X POST http://localhost:4001/simulate \
  -H 'content-type: application/json' -d '{"count": 50}' > /dev/null
sleep 1

echo "5/6 dbt build"
docker compose run --rm dbt build

echo "6/6 generate report"
npm run report -w agent
./scripts/check-demo.sh
```

- [ ] **Step 4: Run the full demo to verify it passes**

Run: `./scripts/demo.sh`
Expected: six numbered stages, dbt `Completed successfully`, then `PASS: end-to-end demo produced a valid report`. Also verify the oracle manually once: `wc -l out/ledger.jsonl` → 50, and `docker compose exec postgres psql -U switchboard -c "select count(*) from raw.raw_crm_events"` → 50.

- [ ] **Step 5: Commit and merge gate**

```bash
git add scripts
git commit -m "feat: one-command end-to-end walking-skeleton demo"
```
Then: run the FULL suite one final time (`npm run typecheck && npm test` with DATABASE_URL set, plus `./scripts/demo.sh`), write the Phase 0 entry in `docs/log/phase0.md` (planned vs. actually happened), and stop for review before Phase 1.

---

## Phases 1–4 (outline only — each gets its own plan doc when reached, per spec §6)

- **Phase 1:** fault injection (fault-plan seed) in mock; idempotency keys, transactional outbox, cursors, DLQ + replay CLI, quarantine table in ingest; chaos reconciliation test (ledger vs raw tables).
- **Phase 2:** billing + support mocks; 3-tier identity resolution; `customer_360` marts; dbt tests gating CI; 5-min micro-batch orchestration via pg-boss.
- **Phase 3:** full read tools; `flag_account_for_review` + approval gate + audit log; real agentic loop; eval split (CI action-safety / nightly LLM-judged).
- **Phase 4:** OTel + Grafana + DLQ alert; deploy (Fly.io/Railway ADR); read-only demo page; README case study, discovery memo, demo video, citation re-verification.

## Self-Review Notes

- **Spec coverage (Phase 0 exit = "end-to-end demo from one command"):** mock+ledger (T2/T3), naive ingest (T4), one dbt model (T5), one MCP read tool (T6), host + stub report + one action-safety eval (T7), one-command demo (T8). Covered.
- **Known Phase 0 simplifications, all sanctioned by spec §6:** no idempotency (dupes stored raw), no faults, in-process MCP transport (stdio/HTTP arrive Phase 3), template LLM fallback.
- **Type consistency checked:** event shape (Task 3 ↔ Task 4 test), `READ_TOOLS` (Task 6 ↔ Task 7 eval), schema env `DBT_SCHEMA` default `public_analytics` (Tasks 5/6/7).
- **External-API risk flagged, not hidden:** MCP SDK + Anthropic SDK APIs and the dbt image install are verified by explicit steps (Tasks 1/5/6) because package APIs postdate any static plan.
