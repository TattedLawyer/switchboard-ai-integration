// Knowledge-base pins — migration `023_knowledge_base.sql` (plan C6, first slice).
//
// 🚨 RED BY MEASUREMENT, NOT BY ABSENCE (the 017/018/021/022 idiom): every grant pin
// asserts the SQLSTATE through the pool whose role would hit it in production, and the
// dimension pin asserts the server's own arity error — the mechanical enforcement of the
// pinned 1024, which no TypeScript type can provide.
//
// Nothing here writes to the named `switchboard` database: `freshCrmDb()` creates its own
// ephemeral database (001–023 applied) and drops it.
import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import { freshCrmDb, sqlstate, TEST_TENANT } from "./helpers/crmdb.js";

let admin: pg.Pool;
let crm: pg.Pool;
let approval: pg.Pool;
let agent: pg.Pool;
let cleanup: () => Promise<void>;

/** A second role pool over the same ephemeral database, in the 022 test's idiom. */
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

/** The author must be a real approver row — `created_by` is a FOREIGN KEY, so an entry
 *  authored by nobody is unrepresentable (015's own attribution doctrine, reused). */
async function seedAuthor(): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `insert into approval.users (email) values ('marisol@example.com') returning id`,
  );
  return r.rows[0].id;
}

/** Authored through the APPROVAL pool — the dashboard's role is the writer the shipped
 *  system uses, and a fixture built through the owner pool would test a universe the
 *  shipped code cannot reach (crmdb.ts's own header). */
async function seedEntry(authorId: string, body = "3BR house-and-lot, Alabang Hills, ₱18.5M."):
  Promise<string> {
  const r = await approval.query<{ id: string }>(
    `insert into kb.general_entries (tenant_id, kind, title, body, created_by)
     values ($1, 'listing', 'Alabang Hills 3BR', $2, $3) returning id`,
    [TEST_TENANT, body, authorId],
  );
  return r.rows[0].id;
}

function vec(dim: number, fill = 0.5): string {
  return JSON.stringify(Array.from({ length: dim }, () => fill));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Chunk inserted through the CRM pool — the embedding daemon's role is the writer. */
async function seedChunk(
  entryId: string,
  ordinal: number,
  text: string,
  embedding: string | null,
): Promise<string> {
  const r = await crm.query<{ id: string }>(
    `insert into kb.general_chunks (entry_id, ordinal, text, embedding, content_hash)
     values ($1, $2, $3, $4, $5) returning id`,
    [entryId, ordinal, text, embedding, sha256(text)],
  );
  return r.rows[0].id;
}

describe("023: the embedding column mechanically enforces the pinned 1024 dimensions", () => {
  // P1. mutation, RUN ✅ 2026-08-19, two variants:
  //   (a) `vector(1024)` -> bare `vector`: the MIGRATION itself dies — the HNSW index
  //       refuses an untyped column. Observed: `error: column does not have dimensions`
  //       at migrate.ts:122; `Tests  8 skipped (8)`, exit 1.
  //   (b) `vector(1024)` -> `vector(1536)`: `Tests  3 failed | 5 passed (8)` —
  //       AssertionError: expected 'expected 1536 dimensions, not 768' to contain
  //       'expected 1024 dimensions, not 768' — the assertion reads the pinned arity out
  //       of the server's own error, so a silently re-dimensioned column cannot pass.
  //   Restored, green.
  it("rejects a 768-length vector with the server's own arity error", async () => {
    const author = await seedAuthor();
    const entry = await seedEntry(author);
    let message = "NO-ERROR";
    try {
      await seedChunk(entry, 0, "passage text", vec(768));
    } catch (err) {
      message = String((err as Error).message);
    }
    expect(message).toContain("expected 1024 dimensions, not 768");
  });

  it("accepts exactly 1024 dimensions", async () => {
    const author = await seedAuthor();
    const entry = await seedEntry(author);
    const id = await seedChunk(entry, 0, "passage text", vec(1024));
    expect(id).toBeTruthy();
  });

  it("carries the HNSW cosine index the retrieval query depends on", async () => {
    const r = await admin.query(
      `select indexdef from pg_indexes
        where schemaname = 'kb' and tablename = 'general_chunks'
          and indexdef ilike '%hnsw%'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].indexdef).toContain("vector_cosine_ops");
  });
});

describe("023: role surface — each role holds exactly the verbs its job performs", () => {
  // P7. mutations, RUN ✅ 2026-08-19, both directions:
  //   (a) NARROWING — delete the entire grant/revoke block: `Tests  5 failed | 3 passed`,
  //       every role-pool fixture dying `error: permission denied for schema kb`.
  //   (b) WIDENING — append `grant select on kb.general_entries to switchboard_agent;
  //       grant update on kb.general_entries to switchboard_crm;`: the crm forged-body
  //       pin went red (`expected 'NO-ERROR' to be '42501'`) but the agent pin stayed
  //       green — the schema-USAGE denial is an outer gate that masks a table-grant leak.
  //       Adding `grant usage on schema kb to switchboard_agent;` then tripped the agent
  //       pin too (`expected 'NO-ERROR' to be '42501'`, 2 failed | 6 passed). So the
  //       agent's denial is two-layered, and this pin catches the only combination that
  //       actually exposes data. Restored, green (8/8).
  it("switchboard_agent gets 42501 on both tables — named only to be denied", async () => {
    expect(await sqlstate(() => agent.query(`select id from kb.general_entries`))).toBe("42501");
    expect(await sqlstate(() => agent.query(`select id from kb.general_chunks`))).toBe("42501");
    expect(
      await sqlstate(() =>
        agent.query(
          `insert into kb.general_entries (tenant_id, kind, title, body, created_by)
           values ('${TEST_TENANT}', 'faq', 'x', 'y', gen_random_uuid())`,
        ),
      ),
    ).toBe("42501");
  });

  it("the approval role authors entries and edits them column-by-column, but cannot delete", async () => {
    const author = await seedAuthor();
    const entry = await seedEntry(author); // INSERT through the approval pool
    expect(
      await sqlstate(() =>
        approval.query(
          `update kb.general_entries
              set title = 'renamed', body = 'edited', kind = 'faq',
                  status = 'retired', retired_at = now(), updated_at = now()
            where id = $1`,
          [entry],
        ),
      ),
    ).toBe("NO-ERROR");
    // NO DELETE anywhere: retirement is a status, never a vanished row.
    expect(
      await sqlstate(() => approval.query(`delete from kb.general_entries where id = $1`, [entry])),
    ).toBe("42501");
    // And the author column is not among the granted UPDATE columns: attribution is
    // written once, at insert, like 015's decisions.
    expect(
      await sqlstate(() =>
        approval.query(`update kb.general_entries set created_by = gen_random_uuid() where id = $1`, [
          entry,
        ]),
      ),
    ).toBe("42501");
  });

  it("the approval role holds nothing on chunks — embedding is the daemon's job", async () => {
    // ENUMERATED COLUMN BY COLUMN, not just `select id`. Postgres privileges are
    // per-column: a future `grant select (embedded_at) on kb.general_chunks to
    // switchboard_approval` would move this boundary while a one-column `id` probe
    // stayed green — the exact vacuity 024 made live, because 024's whole design brief
    // was "expose index state WITHOUT any grant on the base table" and a column-level
    // grant is the tempting shortcut. Every column is asserted, and `select *` with it,
    // so NO column-level grant of any subset can leave this pin green.
    for (const col of [
      "id",
      "entry_id",
      "text",
      "content_hash",
      "embedding",
      "embedded_at",
      "ordinal",
    ]) {
      expect(
        await sqlstate(() => approval.query(`select ${col} from kb.general_chunks`)),
        `column ${col}`,
      ).toBe("42501");
    }
    expect(await sqlstate(() => approval.query(`select * from kb.general_chunks`))).toBe("42501");
  });

  it("the crm role reads entries but cannot write them", async () => {
    const author = await seedAuthor();
    const entry = await seedEntry(author);
    expect(
      await sqlstate(() => crm.query(`select id, tenant_id, kind, title, body, status from kb.general_entries`)),
    ).toBe("NO-ERROR");
    expect(
      await sqlstate(() =>
        crm.query(`update kb.general_entries set body = 'forged' where id = $1`, [entry]),
      ),
    ).toBe("42501");
    expect(
      await sqlstate(() =>
        crm.query(
          `insert into kb.general_entries (tenant_id, kind, title, body, created_by)
           values ($1, 'faq', 'x', 'y', $2)`,
          [TEST_TENANT, author],
        ),
      ),
    ).toBe("42501");
  });

  it("the crm role writes chunks and their embedding columns, but cannot rewrite text or delete", async () => {
    const author = await seedAuthor();
    const entry = await seedEntry(author);
    const chunk = await seedChunk(entry, 0, "passage text", null); // INSERT through the crm pool
    expect(
      await sqlstate(() =>
        crm.query(
          `update kb.general_chunks set embedding = $2, embedded_at = now() where id = $1`,
          [chunk, vec(1024)],
        ),
      ),
    ).toBe("NO-ERROR");
    // `text` and `content_hash` are written once, at insert: an embedder that could
    // rewrite the text it embeds could silently decouple hash, text and vector.
    expect(
      await sqlstate(() => crm.query(`update kb.general_chunks set text = 'forged' where id = $1`, [chunk])),
    ).toBe("42501");
    expect(
      await sqlstate(() => crm.query(`delete from kb.general_chunks where id = $1`, [chunk])),
    ).toBe("42501");
  });
});
