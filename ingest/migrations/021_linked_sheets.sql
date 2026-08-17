-- 021: the linked Google Sheet — schema for the sheet-as-master-contact-list foundation.
--
-- WHY A NEW FILE. 014-020 are applied and checksum-enforced (src/migrate.ts): editing an
-- applied file makes `runMigrations` refuse. Everything here is new.
--
-- IMPLICITLY TRANSACTIONAL, in 015/016/019/020's idiom: `migrate.ts` submits this file as
-- ONE `client.query(sql)` and it contains no BEGIN/COMMIT.
--
-- WHAT THIS IS. The client's Google Sheet becomes the master contact list: rows in her
-- sheet become contacts in the follow-up loop. This file is the identity layer only —
-- which sheet is linked, which sheet row a contact came from, and the health ledger of
-- every read. The transport lives in `crm/src/sheet-client.ts`; the adoption pass in
-- `crm/src/sheet-adopt.ts` (owner-run, on the reconcile loop).
--
-- ROW IDENTITY IS DEVELOPER METADATA, measured against the live Sheets API (spike,
-- 2026-08-17), not documentation:
--   · metadata travels with the row through a full-range sort;
--   · insert shifts refs with rows; DELETE makes only that row's ref disappear — identity
--     and the deletion signal are the same primitive;
--   · a duplicated tab carries values but NO metadata — a copy can never impersonate the
--     original;
--   · refs are written with DOCUMENT visibility, because PROJECT-scoped metadata becomes
--     invisible if the Cloud project ever changes — which would read as "she deleted
--     everything".

-- ---------------------------------------------------------------------------------------
-- LINKED SHEETS — one active per tenant; the row is PERMANENT once created.
-- ---------------------------------------------------------------------------------------
--
-- 🚨 `unique (tenant_id, spreadsheet_id)` IS REQUIRED, not decorative: without it the same
-- sheet linked twice imports every row twice — each link would adopt every row under a
-- fresh `linked_sheet_id`, and the partial unique on contacts below would not even see the
-- collision because the tuples differ.
--
-- 🚨 UNLINK SETS `unlinked_at`, NEVER DELETES — and a RELINK MUST REACTIVATE THE SAME ROW,
-- matched on `spreadsheet_id`. A fresh row on relink would change every contact's identity
-- tuple `(linked_sheet_id, row_ref)`, so the next adoption pass would re-import the whole
-- sheet as duplicates while the originals sit deactivated with the history orphaned on
-- them. `crm/src/sheet-adopt.ts linkSheet` upserts on this constraint; the constraint is
-- what makes "same row" enforceable rather than aspirational.
--
-- ONE LINKED SHEET AT A TIME is an owner decision (swap = unlink then link; multi-sheet is
-- a later feature). `linked_sheets_one_active` makes it schema, not prose: relinking sheet
-- B while sheet A is active is a 23505, not a silent second master.
create table if not exists crm.linked_sheets (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null,
  spreadsheet_id text        not null check (length(btrim(spreadsheet_id)) > 0),
  label          text        null,
  linked_at      timestamptz not null default now(),
  unlinked_at    timestamptz null,
  constraint linked_sheets_one_per_sheet unique (tenant_id, spreadsheet_id)
);

create unique index if not exists linked_sheets_one_active
  on crm.linked_sheets (tenant_id)
  where unlinked_at is null;

-- ---------------------------------------------------------------------------------------
-- CONTACT ↔ ROW BINDING. Nullable: manual contacts keep both null.
-- ---------------------------------------------------------------------------------------
--
-- Sheet identity is stored PER CONTACT NOW, even though only one sheet can be linked,
-- because retrofitting identity later means backfilling every contact (owner decision).
alter table crm.contacts add column if not exists linked_sheet_id uuid null
  references crm.linked_sheets (id);
alter table crm.contacts add column if not exists row_ref text null;

-- One contact per sheet row. Partial: the many manual (null, null) contacts never collide.
create unique index if not exists contacts_one_per_sheet_row
  on crm.contacts (linked_sheet_id, row_ref)
  where linked_sheet_id is not null and row_ref is not null;

-- Identity is the PAIR. A contact with a sheet but no ref (or a ref with no sheet) is a
-- tuple nothing can ever match — unrepresentable rather than merely unreachable.
do $$
begin
  alter table crm.contacts add constraint contacts_sheet_identity_paired
    check ((linked_sheet_id is null) = (row_ref is null));
exception
  when duplicate_object then null; -- re-run race in parallel test migrations: fine
end
$$;

-- ---------------------------------------------------------------------------------------
-- SHEET READS — the health ledger. One row per adoption pass, success or failure.
-- ---------------------------------------------------------------------------------------
--
-- `ok = false` covers BOTH a failed fetch and a pass halted by its circuit breaker: in
-- either case the pass changed nothing and the operator surface must say so. `detail`
-- begins with a machine-readable code (`unreachable:`, `permission_revoked:`,
-- `breaker_count:`, `breaker_drift:`, `ok:`) that `crm/src/sheet-adopt.ts
-- sheetReadCode` parses for the digest and reconcile lines — the ACTIONS for those states
-- differ, so the sentences must (re-share vs wait vs check the sheet).
--
-- Append-only, matching 020's posture: the pass inserts; nothing updates or deletes.
create table if not exists crm.sheet_reads (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null,
  linked_sheet_id uuid        not null references crm.linked_sheets (id),
  at              timestamptz not null default now(),
  ok              boolean     not null,
  detail          text        null
);

create index if not exists sheet_reads_latest
  on crm.sheet_reads (linked_sheet_id, at desc);

-- ---------------------------------------------------------------------------------------
-- GRANTS. Adoption, link and unlink run as the MIGRATION OWNER on the reconcile loop
-- (016 §I-3's operator posture; the owner already holds everything it needs), so NOTHING
-- here widens `switchboard_crm`'s writes.
-- ---------------------------------------------------------------------------------------
--
-- `switchboard_crm` gets SELECT ONLY on the two new tables, for exactly one consumer: the
-- daily digest (`crm/src/digest.ts`) runs on the CRM pool and must be able to SAY "sheet
-- unreachable" / "access revoked — re-share with <service account>" / "N rows missing".
-- Health is read; adoption is written — only the first is granted.
grant select on crm.linked_sheets to switchboard_crm;
grant select on crm.sheet_reads   to switchboard_crm;

-- Named only to be denied, in 014/016/019/020's idiom.
revoke all on crm.linked_sheets from switchboard_agent;
revoke all on crm.sheet_reads   from switchboard_agent;
revoke all on crm.linked_sheets from switchboard_approval;
revoke all on crm.sheet_reads   from switchboard_approval;

-- ---------------------------------------------------------------------------------------
-- 🚨 DEFERRED TO THE PROPOSER INTEGRATION (part 2): the contact-detail column revoke.
-- ---------------------------------------------------------------------------------------
--
-- The design endpoint is that contact DETAILS (`email_address`, `source_detail`,
-- `looking_for`) are read LIVE from the sheet, and `switchboard_crm` loses SELECT on those
-- three columns — a 42501 is a control; a comment is not. The columns are NOT dropped:
-- `approval/src/proposal.ts`'s `placeCallPayloadSchema` requires `context.source_detail`
-- and `context.looking_for` under `.strict()`, so dropping them is a two-workspace grammar
-- change that would break pending proposals.
--
-- MEASURED 2026-08-17 on a 001-020 database: with the revoke below applied, the shipped
-- proposer's `loadContact` (`crm/src/proposer.ts`) fails `permission denied for table
-- contacts` under `switchboard_crm` — it still reads all three columns at HEAD, as do the
-- email leg and the rationale builder, across eight test files. The revoke therefore CANNOT
-- land before the proposer reads details from the sheet; it lands WITH that change, and
-- gets its own run pin then. The exact statements, ready:
--
--   revoke select on crm.contacts from switchboard_crm;
--   grant select (id, tenant_id, display_name, channel, source, active,
--                 follow_up_interval_days, next_due_at, dial_rotation_ordinal,
--                 created_at, updated_at, linked_sheet_id, row_ref)
--     on crm.contacts to switchboard_crm;
