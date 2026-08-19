// Index-state pins — migration `024_kb_index_state_view.sql`.
//
// WHAT 024 IS. 023 deliberately grants `switchboard_approval` NOTHING on
// `kb.general_chunks` ("a compromised dashboard session should not be able to touch a
// vector"), but the authoring dashboard must honestly say whether an entry is searchable
// yet — and that state lives in the chunks table. 024's answer is an OWNER-OWNED VIEW
// (`kb.entry_index_state`) exposing DERIVED per-entry state only, with SELECT granted on
// the view and still nothing on the base table. These pins measure all four edges of that
// boundary through the pools whose roles would hit them in production.
//
// 🚨 RED BY MEASUREMENT, NOT BY ABSENCE (the 017/018/021/022/023 idiom): every denial pin
// asserts the SQLSTATE — 42501 for a privilege refusal, 42703 for a column the view does
// not even have — never a bare `toThrow()`.
//
// Nothing here writes to the named `switchboard` database: `freshCrmDb()` creates its own
// ephemeral database (001–024 applied) and drops it.
import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import { freshCrmDb, sqlstate, TEST_TENANT } from "./helpers/crmdb.js";

let admin: pg.Pool;
let crm: pg.Pool;
let approval: pg.Pool;
let agent: pg.Pool;
let cleanup: () => Promise<void>;

/** A second role pool over the same ephemeral database, in the 022/023 tests' idiom. */
function rolePool(dbUrl: string, role: string): pg.Pool {
  const u = new URL(dbUrl);
  u.username = role;
  u.password = role;
  const pool = new pg.Pool({ connectionString: u.toString(), max: 2 });
  pool.on("error", () => {});
  return pool;
}

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  crm = db.crm;
  approval = rolePool(db.url, "switchboard_approval");
  agent = rolePool(db.url, "switchboard_agent");
  cleanup = async () => {
    await approval.end().catch(() => {});
    await agent.end().catch(() => {});
    await db.cleanup();
  };
}, 120_000);

afterEach(async () => {
  await admin.query("delete from kb.general_chunks");
  await admin.query("delete from kb.general_entries");
  await admin.query("delete from approval.users");
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

async function seedAuthor(): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `insert into approval.users (email) values ('marisol@example.com') returning id`,
  );
  return r.rows[0].id;
}

/** Authored through the APPROVAL pool — the dashboard's role is the writer the shipped
 *  system uses (crmdb.ts's own header on owner-pool fixtures). */
async function seedEntry(authorId: string, title = "Alabang Hills 3BR"): Promise<string> {
  const r = await approval.query<{ id: string }>(
    `insert into kb.general_entries (tenant_id, kind, title, body, created_by)
     values ($1, 'listing', $2, '3BR house-and-lot, Alabang Hills, ₱18.5M.', $3)
     returning id`,
    [TEST_TENANT, title, authorId],
  );
  return r.rows[0].id;
}

function vec(dim = 1024, fill = 0.5): string {
  return JSON.stringify(Array.from({ length: dim }, () => fill));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** A PENDING chunk, inserted the way the daemon inserts one: through the CRM pool, with
 *  no embedding and no embedded_at. */
async function seedPendingChunk(entryId: string, ordinal: number, text: string): Promise<string> {
  const r = await crm.query<{ id: string }>(
    `insert into kb.general_chunks (entry_id, ordinal, text, content_hash)
     values ($1, $2, $3, $4) returning id`,
    [entryId, ordinal, text, sha256(text)],
  );
  return r.rows[0].id;
}

/** The daemon's embed write: embedding AND embedded_at together, through the CRM pool.
 *  (An insert carrying a vector but no embedded_at is a state the shipped embed pass
 *  never produces — see embed-pass.ts's row-state contract.) */
async function embedChunk(chunkId: string): Promise<void> {
  await crm.query(
    `update kb.general_chunks set embedding = $2, embedded_at = now() where id = $1`,
    [chunkId, vec()],
  );
}

/** The daemon's supersede write: embedding nulled, embedded_at stamped with the
 *  retirement time — the exact row shape `embedded_at` alone cannot tell from EMBEDDED. */
async function supersedeChunk(chunkId: string): Promise<void> {
  await crm.query(
    `update kb.general_chunks set embedding = null, embedded_at = now() where id = $1`,
    [chunkId],
  );
}

interface StateRow {
  entry_id: string;
  chunk_count: number;
  embedded_count: number;
  pending_count: number;
  state: string;
}

/** Read THROUGH THE APPROVAL POOL — the dashboard's role is the only consumer this view
 *  exists for, and reading it through any wider pool would test a universe the shipped
 *  dashboard cannot reach. */
async function stateOf(entryId: string): Promise<StateRow> {
  const r = await approval.query<StateRow>(
    `select entry_id, chunk_count, embedded_count, pending_count, state
       from kb.entry_index_state where entry_id = $1`,
    [entryId],
  );
  expect(r.rowCount).toBe(1);
  return r.rows[0];
}

describe("024/V1: the approval role reads honest per-entry index state through the view", () => {
  it("an entry with no chunks reads not_indexed", async () => {
    const entry = await seedEntry(await seedAuthor());
    const s = await stateOf(entry);
    expect(s.chunk_count).toBe(0);
    expect(s.embedded_count).toBe(0);
    expect(s.pending_count).toBe(0);
    expect(s.state).toBe("not_indexed");
  });

  it("an entry with pending chunks reads indexing", async () => {
    const entry = await seedEntry(await seedAuthor());
    await seedPendingChunk(entry, 0, "first passage");
    const s = await stateOf(entry);
    expect(s.chunk_count).toBe(1);
    expect(s.embedded_count).toBe(0);
    expect(s.pending_count).toBe(1);
    expect(s.state).toBe("indexing");
  });

  it("a fully embedded entry reads indexed", async () => {
    const entry = await seedEntry(await seedAuthor());
    const chunk = await seedPendingChunk(entry, 0, "first passage");
    await embedChunk(chunk);
    const s = await stateOf(entry);
    expect(s.chunk_count).toBe(1);
    expect(s.embedded_count).toBe(1);
    expect(s.pending_count).toBe(0);
    expect(s.state).toBe("indexed");
  });

  it("an embedded current generation WITH superseded rows reads indexed, and the superseded row is not counted as embedded — the case `embedded_at` alone gets wrong", async () => {
    // A superseded row is (embedding NULL, embedded_at NOT NULL) — embed-pass.ts's
    // row-state contract. A view derived from `embedded_at is not null` would count it
    // as embedded (embedded_count 2) and could call a half-dead entry live; the state
    // must derive from `embedding is not null`.
    const entry = await seedEntry(await seedAuthor());
    const oldGen = await seedPendingChunk(entry, 0, "the old text");
    await embedChunk(oldGen);
    await supersedeChunk(oldGen);
    const newGen = await seedPendingChunk(entry, 1, "the edited text");
    await embedChunk(newGen);

    const s = await stateOf(entry);
    expect(s.chunk_count).toBe(2); // superseded text is kept forever (023's no-DELETE)
    expect(s.embedded_count).toBe(1); // NOT 2: the superseded row carries no vector
    expect(s.pending_count).toBe(0);
    expect(s.state).toBe("indexed");
  });
});

describe("024/V2: the base-table boundary DID NOT MOVE — approval still holds nothing on kb.general_chunks", () => {
  it("42501 on every column and on select *", async () => {
    // Enumerated column by column, not just `select id`: a future column-level grant
    // excluding `id` would leave a one-column probe green while the boundary moved.
    // The full enumeration also lives in migration-023.test.ts (the pin 023 owns);
    // repeated here because 024 is the migration whose one job was to expose state
    // WITHOUT moving this boundary.
    for (const col of ["id", "entry_id", "text", "content_hash", "embedding", "embedded_at", "ordinal"]) {
      expect(
        await sqlstate(() => approval.query(`select ${col} from kb.general_chunks`)),
        `column ${col}`,
      ).toBe("42501");
    }
    expect(await sqlstate(() => approval.query(`select * from kb.general_chunks`))).toBe("42501");
  });
});

describe("024/V3: the vector does not cross the boundary in any form", () => {
  it("selecting embedding THROUGH the view is 42703 — the column does not exist there", async () => {
    expect(await sqlstate(() => approval.query(`select embedding from kb.entry_index_state`))).toBe(
      "42703",
    );
  });

  it("neither do text and content_hash", async () => {
    expect(await sqlstate(() => approval.query(`select text from kb.entry_index_state`))).toBe(
      "42703",
    );
    expect(
      await sqlstate(() => approval.query(`select content_hash from kb.entry_index_state`)),
    ).toBe("42703");
  });
});

describe("024/V4: switchboard_agent gets nothing, as everywhere", () => {
  it("42501 on the view", async () => {
    expect(await sqlstate(() => agent.query(`select entry_id from kb.entry_index_state`))).toBe(
      "42501",
    );
    expect(await sqlstate(() => agent.query(`select * from kb.entry_index_state`))).toBe("42501");
  });
});
