// Core loop / T2 pins — migration `016_crm_followup.sql`.
//
// Every mutation named below was performed against the FILE and the suite re-run against a
// fresh ephemeral database. Nothing here writes to the named `switchboard` database.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runMigrations } from "../../ingest/src/migrate.js";
import { appliedMigrations } from "../../ingest/src/migrate.js";
import {
  freshCrmDb,
  seedContact,
  seedNumber,
  seedSettings,
  startTouch,
  sqlstate,
  TEST_TENANT,
} from "./helpers/crmdb.js";

let admin: pg.Pool;
let crm: pg.Pool;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  crm = db.crm;
  cleanup = db.cleanup;
}, 120_000);

afterEach(async () => {
  await admin.query("delete from crm.answers");
  await admin.query("delete from crm.touches");
  await admin.query("delete from crm.follow_up_actions");
  await admin.query("delete from crm.follow_ups");
  await admin.query("delete from crm.phone_numbers");
  await admin.query("delete from crm.questions");
  await admin.query("delete from crm.question_sets");
  await admin.query("delete from crm.contacts");
  await admin.query("delete from crm.outreach_settings");
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe("T2: two contacts may share a number; one contact may not hold it twice", () => {
  // mutation: `unique (contact_id, phone_e164)` -> `unique (phone_e164)` -> red.
  //           RUN ✅ 2026-08-09
  //   Observed: the SHARED-HOUSEHOLD assertion failed —
  //     AssertionError: expected '23505' to be 'NO-ERROR'
  //   i.e. the second contact's insert of the same household line was refused. That is
  //   FALSEHOODS.md's "a phone number uniquely identifies an individual", encoded.
  //
  // (M1: rev 2's stated mutation named `(tenant_id, phone_e164)`, which is NOT PERFORMABLE
  //  — `crm.phone_numbers` has no `tenant_id` column, so the mutation errors instead of
  //  reding. A mutation that cannot run is a finding, not a pin. Corrected here.)
  it("admits one household line against two different contacts", async () => {
    const ana = await seedContact(admin, { displayName: "Ana Reyes" });
    const ben = await seedContact(admin, { displayName: "Ben Reyes" });
    await seedNumber(admin, ana, "+639171234567");
    const code = await sqlstate(() => seedNumber(admin, ben, "+639171234567"));
    expect(code).toBe("NO-ERROR");
  });

  it("refuses the same number twice on ONE contact with 23505", async () => {
    const ana = await seedContact(admin);
    await seedNumber(admin, ana, "+639171234567", 0);
    const code = await sqlstate(() => seedNumber(admin, ana, "+639171234567", 1));
    expect(code).toBe("23505");
  });
});

describe("T2: the open-guard, and what it deliberately does not guard", () => {
  const today = () => new Date().toISOString().slice(0, 10);
  const plusDays = (n: number) =>
    new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  // mutation: drop `follow_ups_one_open` -> red. RUN ✅ 2026-08-09
  //   Observed: AssertionError: expected 'NO-ERROR' to be '23505'
  it("refuses a second OPEN UNBLOCKED follow-up for one contact with 23505", async () => {
    const ana = await seedContact(admin);
    await admin.query(`insert into crm.follow_ups (contact_id, due_date) values ($1, $2)`, [
      ana,
      today(),
    ]);
    const code = await sqlstate(() =>
      admin.query(`insert into crm.follow_ups (contact_id, due_date) values ($1, $2)`, [
        ana,
        plusDays(1),
      ]),
    );
    expect(code).toBe("23505");
  });

  // 🚨 REVIEW B4. mutation: make the guard `(contact_id) where closed_at is null` — i.e.
  //           include blocked rows -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 18 passed (19)`,
  //     AssertionError: expected '23505' to be 'NO-ERROR'   (the second blocked row, on a
  //                                                          DIFFERENT due-date, refused)
  //   With that guard, nothing ever closes a blocked row and nothing CAN, so a contact who
  //   is blocked once is suppressed FOREVER. The anti-silence mechanism becomes a permanent
  //   silencer — the same shape as this project's earlier safety feature that disabled its
  //   own flood cap.
  it("does not let a BLOCKED follow-up occupy the open-guard", async () => {
    const ana = await seedContact(admin, { channel: "email", email: null });
    await admin.query(
      `insert into crm.follow_ups (contact_id, due_date, blocked_reason)
       values ($1, $2, 'no_email_address')`,
      [ana, today()],
    );
    // A different due-date: permitted, because the block must be re-evaluated every cycle.
    const nextCycle = await sqlstate(() =>
      admin.query(
        `insert into crm.follow_ups (contact_id, due_date, blocked_reason)
         values ($1, $2, 'no_email_address')`,
        [ana, plusDays(1)],
      ),
    );
    expect(nextCycle).toBe("NO-ERROR");
  });

  // mutation: drop `follow_ups_one_per_due` -> red. RUN ✅ 2026-08-09
  //   Observed: AssertionError: expected 'NO-ERROR' to be '23505'
  it("refuses a second row for the SAME due-date with 23505", async () => {
    const ana = await seedContact(admin);
    await admin.query(
      `insert into crm.follow_ups (contact_id, due_date, blocked_reason)
       values ($1, $2, 'no_email_address')`,
      [ana, today()],
    );
    const code = await sqlstate(() =>
      admin.query(
        `insert into crm.follow_ups (contact_id, due_date, blocked_reason)
         values ($1, $2, 'no_email_address')`,
        [ana, today()],
      ),
    );
    expect(code).toBe("23505");
  });

  // 🚨 B-B RECOVERY. Round 1 asked for this pin; rev 4 did not add it, and rev 4's stated
  // recovery property ("no closing logic to forget") was FALSE.
  // mutation: recover by INSERTing a second row for the same due-date instead of UPDATEing
  //           the existing one -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 18 passed (19)`,
  //     AssertionError: expected '23505' to be 'NO-ERROR'
  //   — exactly the `23505 follow_ups_one_per_due` the round-2 reviewer measured, i.e. the
  //   dead end rev 4's design walked into.
  it("recovers a blocked contact by UPDATEing the same row, under switchboard_crm", async () => {
    const ana = await seedContact(admin, { channel: "email", email: null });
    // Cycle N: no address on file.
    await crm.query(
      `insert into crm.follow_ups (contact_id, due_date, blocked_reason)
       values ($1, current_date, 'no_email_address')`,
      [ana],
    );
    // She adds the address that afternoon (operator CLI = owner role).
    await admin.query(`update crm.contacts set email_address = $2 where id = $1`, [
      ana,
      "ana@example.com",
    ]);
    // Cycle N+1: the proposer clears the block ON THE EXISTING ROW. The grant covers it.
    const recover = await sqlstate(() =>
      crm.query(
        `update crm.follow_ups set blocked_reason = null
          where contact_id = $1 and due_date = current_date`,
        [ana],
      ),
    );
    expect(recover).toBe("NO-ERROR");

    const rows = await admin.query<{ n: string }>(
      `select count(*) as n from crm.follow_ups where contact_id = $1`,
      [ana],
    );
    expect(rows.rows[0].n).toBe("1"); // ONE row, not two — no 23505 dead end

    const open = await admin.query<{ n: string }>(
      `select count(*) as n from crm.follow_ups
        where contact_id = $1 and closed_at is null and blocked_reason is null`,
      [ana],
    );
    expect(open.rows[0].n).toBe("1"); // now proposable

    // And the proposal for it can be recorded.
    const act = await sqlstate(() =>
      crm.query(
        `insert into crm.follow_up_actions (follow_up_id, channel, proposal_id)
         select id, 'email', gen_random_uuid() from crm.follow_ups where contact_id = $1`,
        [ana],
      ),
    );
    expect(act).toBe("NO-ERROR");
  });
});

describe("T2: the summary cap is a DB CHECK, not an app validation", () => {
  // mutation: drop `touches_summary_capped` -> red. RUN ✅ 2026-08-09
  //   Observed: AssertionError: expected 'NO-ERROR' to be '23514'
  it("refuses a 1201-character summary with 23514", async () => {
    const ana = await seedContact(admin);
    const t = await startTouch(admin, ana);
    const ok = await sqlstate(() =>
      crm.query(`update crm.touches set summary = $2 where id = $1`, [t, "x".repeat(1200)]),
    );
    expect(ok).toBe("NO-ERROR");
    const over = await sqlstate(() =>
      crm.query(`update crm.touches set summary = $2 where id = $1`, [t, "x".repeat(1201)]),
    );
    expect(over).toBe("23514");
  });
});

describe("T2: the settings row refuses an unusable opening line (I-4)", () => {
  // mutation: drop either CHECK from `crm.outreach_settings` -> red. RUN ✅ 2026-08-09
  //   Observed, dropping `outreach_settings_opening_line_usable`:
  //     `Tests  2 failed | 17 passed (19)` — expected 'NO-ERROR' to be '23514', twice
  //     (the empty named line, and the named line carrying no {name}).
  //   Observed, dropping `..._no_name_usable`:
  //     `Tests  1 failed | 18 passed (19)` — expected 'NO-ERROR' to be '23514'.
  //
  // `not null` does NOT refuse `''`, and rev 4's prose claimed it did. An empty
  // `opening_line_no_name` means the agent opens a nameless call WITH SILENCE.
  const insertSettings = (opening: string, noName: string) =>
    admin.query(
      `insert into crm.outreach_settings
         (tenant_id, window_start, window_end, opening_line, opening_line_no_name,
          default_interval_days, short_retry_days)
       values ($1, '09:00', '18:00', $2, $3, 30, 3)`,
      [TEST_TENANT, opening, noName],
    );

  it("refuses an empty named opening line with 23514", async () => {
    expect(await sqlstate(() => insertSettings("", "I'm an associate of Marisol."))).toBe(
      "23514",
    );
  });

  it("refuses a named opening line with no {name} placeholder with 23514", async () => {
    expect(
      await sqlstate(() => insertSettings("Hi, calling from the office.", "Associate here.")),
    ).toBe("23514");
  });

  it("refuses a whitespace-only nameless opening line with 23514", async () => {
    expect(await sqlstate(() => insertSettings("May I speak with {name}?", "   "))).toBe(
      "23514",
    );
  });

  it("admits a usable pair", async () => {
    expect(await sqlstate(() => seedSettings(admin))).toBe("NO-ERROR");
  });
});

describe("T2 / B5: switchboard_agent holds NOTHING in schema crm — CATALOG form", () => {
  // mutation: `grant select on crm.touches to switchboard_agent` (appended to 016) -> red.
  //           RUN ✅ 2026-08-09
  //   Observed: AssertionError: expected [ { relation: 'touches', …(2) } ] to deeply
  //             equal []  — plus the schema-USAGE assertion, `expected true to be false`.
  //
  // 🚨 THIS IS A CATALOG ASSERTION, NOT AN ERROR ASSERTION, and that distinction is the
  // whole pin. Rev 2 asserted the ERROR a query got, and the reviewer PROVED that vacuous:
  // the grant was live and recorded in `information_schema.table_privileges`, yet the pin
  // stayed green because schema USAGE is the gate that produced the error.
  //
  // M-1: `pg_class` + `relkind in ('r','p','v','m','f')`, NOT `pg_tables`. `pg_tables`
  // excludes views, matviews and foreign tables — a later `create view crm.touch_digest`
  // granted to the agent would slip straight through. This form also covers tables added by
  // 017 and later, automatically.
  it("has no SELECT/INSERT/UPDATE/DELETE on any relation in crm", async () => {
    const r = await admin.query<{ relation: string; kind: string; privilege: string }>(
      `select c.relname as relation, c.relkind as kind, p.privilege
         from pg_class c
         cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) as p(privilege)
        where c.relnamespace = 'crm'::regnamespace
          and c.relkind in ('r','p','v','m','f')
          and has_table_privilege('switchboard_agent', c.oid, p.privilege)
        order by 1, 3`,
    );
    expect(r.rows).toEqual([]);
  });

  it("has no USAGE on schema crm", async () => {
    const r = await admin.query<{ u: boolean }>(
      `select has_schema_privilege('switchboard_agent', 'crm', 'USAGE') as u`,
    );
    expect(r.rows[0].u).toBe(false);
  });
});

describe("T2: what switchboard_crm may and may not write", () => {
  // mutation: `grant update on crm.answers to switchboard_crm` (or `grant delete`) -> red.
  //           RUN ✅ 2026-08-09
  //   Observed, both directions, `Tests  1 failed | 18 passed (19)` each:
  //     grant update -> AssertionError: expected 'NO-ERROR' to be '42501'
  //     grant delete -> AssertionError: expected 'NO-ERROR' to be '42501'
  it("is refused UPDATE and DELETE on crm.answers with 42501 — append-only in fact", async () => {
    expect(await sqlstate(() => crm.query(`update crm.answers set value = 'x'`))).toBe("42501");
    expect(await sqlstate(() => crm.query(`delete from crm.answers`))).toBe("42501");
  });

  // mutation: replace the column-level grant with table-level `grant update on crm.touches`
  //           -> red. RUN ✅ 2026-08-09
  //   Observed: AssertionError: expected 'NO-ERROR' to be '42501'
  //   (Postgres: "the table-level grant is unaffected by a column-level operation" — so a
  //   table-level UPDATE here would also make later column-level REVOKEs no-ops.)
  it("is refused a crm.touches column outside its column grant with 42501", async () => {
    const ana = await seedContact(admin);
    const t = await startTouch(admin, ana);
    expect(
      await sqlstate(() =>
        crm.query(`update crm.touches set contact_id = $2 where id = $1`, [t, ana]),
      ),
    ).toBe("42501");
    expect(
      await sqlstate(() =>
        crm.query(`update crm.touches set occurred_at = now() where id = $1`, [t]),
      ),
    ).toBe("42501");
  });

  // mutation: remove ANY column from the `grant update ... on crm.touches` /
  //           `on crm.contacts` / `on crm.follow_ups` lists -> red. RUN ✅ 2026-08-09
  //   Observed, each `Tests  1 failed | 18 passed (19)`:
  //     removing `summary_state`          -> expected '42501' to be 'NO-ERROR'
  //     removing `dial_rotation_ordinal`  -> expected '42501' to be 'NO-ERROR'
  //
  // This is the pin that would have caught B2, which was a REAL verified break: rev 2
  // granted `select, insert` only, so every post-call write failed on the first real call.
  it("can write every column the executor and proposer actually write", async () => {
    const ana = await seedContact(admin);
    const t = await startTouch(admin, ana);
    expect(
      await sqlstate(() =>
        crm.query(
          `update crm.touches set
             disposition = 'answered', reached_ordinal = 2, message_left = true,
             identity_unverified = false, summary = 'ok', summary_state = 'generated',
             summary_generated_at = now(), transcript_delivery = 'sent',
             transcript_email_message_id = 'm1', transcript_email_sent_at = now(),
             transcript_email_subject = 'Call with Ana'
           where id = $1`,
          [t],
        ),
      ),
    ).toBe("NO-ERROR");
    expect(
      await sqlstate(() =>
        crm.query(
          `update crm.contacts set next_due_at = now(), updated_at = now(),
                                   dial_rotation_ordinal = 1 where id = $1`,
          [ana],
        ),
      ),
    ).toBe("NO-ERROR");
    await crm.query(
      `insert into crm.follow_ups (contact_id, due_date) values ($1, current_date)`,
      [ana],
    );
    expect(
      await sqlstate(() =>
        crm.query(
          `update crm.follow_ups set closed_at = now(), blocked_reason = null
            where contact_id = $1`,
          [ana],
        ),
      ),
    ).toBe("NO-ERROR");
  });

  // I-3: the CLIs are the migration OWNER, and this is what makes that statement load-bearing
  // rather than decorative.
  it("is refused the intake writes the operator CLIs perform, with 42501", async () => {
    expect(
      await sqlstate(() =>
        crm.query(
          `insert into crm.contacts (tenant_id, channel, source) values ($1, 'call', 'manual')`,
          [TEST_TENANT],
        ),
      ),
    ).toBe("42501");
    expect(
      await sqlstate(() =>
        crm.query(`insert into crm.question_sets (tenant_id, version) values ($1, 9)`, [
          TEST_TENANT,
        ]),
      ),
    ).toBe("42501");
    expect(
      await sqlstate(() => crm.query(`update crm.question_sets set retired_at = now()`)),
    ).toBe("42501");
  });
});

describe("T2: 016 applies on a database already carrying 014+015, and re-runs clean", () => {
  const MIGRATIONS = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "ingest",
    "migrations",
  );

  // mutation: alter one byte of an APPLIED migration file -> `runMigrations` refuses.
  //           RUN ✅ 2026-08-09. Performed from the OTHER side, in-process, by falsifying
  //           the RECORDED checksum rather than the file — the same disagreement, and it
  //           leaves no possibility of a stray migration edit escaping into the repo.
  //   Observed: `migration 016_crm_followup.sql has CHANGED since it was applied (recorded
  //             deadbeefdead…, on disk …)`, asserted by the second test below.
  it("records 016 after 014 and 015 and is a no-op on re-run", async () => {
    const applied = (await appliedMigrations(admin)).map((m) => m.filename);
    expect(applied).toContain("014_approval_proposals.sql");
    expect(applied).toContain("015_approval_lifecycle.sql");
    expect(applied).toContain("016_crm_followup.sql");

    const before = await admin.query<{ n: string }>(
      `select count(*) as n from pg_class where relnamespace = 'crm'::regnamespace`,
    );
    await runMigrations(admin); // no-op
    const after = await admin.query<{ n: string }>(
      `select count(*) as n from pg_class where relnamespace = 'crm'::regnamespace`,
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("refuses to proceed if an applied migration's bytes no longer match", async () => {
    // The file on disk is untouched; the RECORD is falsified instead, which is the same
    // disagreement and leaves no possibility of a stray edit escaping into the repo.
    await admin.query(
      `update ingest.schema_migrations set checksum = 'deadbeefdeadbeef'
        where filename = '016_crm_followup.sql'`,
    );
    await expect(runMigrations(admin)).rejects.toThrow(/has CHANGED since it was applied/);
    // Restore, so the shared database stays usable for whatever runs next.
    const sql = readFileSync(join(MIGRATIONS, "016_crm_followup.sql"), "utf8");
    const { createHash } = await import("node:crypto");
    await admin.query(
      `update ingest.schema_migrations set checksum = $1 where filename = $2`,
      [createHash("sha256").update(sql).digest("hex"), "016_crm_followup.sql"],
    );
  });
});
