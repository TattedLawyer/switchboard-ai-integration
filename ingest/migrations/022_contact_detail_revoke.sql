-- 022: the contact-detail column revoke — contact DETAILS are read LIVE from the sheet.
--
-- WHY A NEW FILE. 014-021 are applied and checksum-enforced (src/migrate.ts): editing an
-- applied file makes `runMigrations` refuse. Everything here is new.
--
-- IMPLICITLY TRANSACTIONAL, in 015/016/019/020/021's idiom: `migrate.ts` submits this file
-- as ONE `client.query(sql)` and it contains no BEGIN/COMMIT — the revoke and the column
-- re-grant below leave no window in which `switchboard_crm` holds the wide grant alongside
-- the narrow one.
--
-- WHAT THIS IS. Migration 021's trailing note deferred exactly this: the design endpoint
-- is that contact DETAILS (`email_address`, `source_detail`, `looking_for`) are read LIVE
-- from the linked sheet at proposal time, and `switchboard_crm` loses SELECT on those
-- three columns — a 42501 is a control; a comment is not. It could not land with 021
-- because the shipped proposer's `loadContact` still read all three columns (measured
-- 2026-08-17: the revoke alone breaks it with `permission denied for table contacts`), so
-- it lands WITH the proposer's live-read integration, as one change-set.
--
-- THE COLUMNS ARE NOT DROPPED. `approval/src/proposal.ts`'s `placeCallPayloadSchema`
-- requires `context.source_detail` and `context.looking_for` under `.strict()`, so
-- dropping them is a two-workspace grammar change that would break pending proposals; and
-- the OWNER-run adoption pass still reads/writes `email_address` for rebind-on-return and
-- the matched-row sync. The revoke narrows exactly one role's read surface.
--
-- 🚨 TABLE-LEVEL REVOKE, THEN COLUMN-LEVEL GRANT — order matters and is 016's own note in
-- reverse: "the table-level grant is unaffected by a column-level operation", so a
-- column-level revoke against 016's table-level SELECT would do NOTHING. The table grant
-- is revoked outright and the surviving columns are granted back by name. The column list
-- retains `display_name` (the nameless-call discriminator and the claim/rotation surface
-- reads it) and deliberately drops `email_address`, `source_detail`, `looking_for`.
-- 016's column-level UPDATE grant (next_due_at, updated_at, dial_rotation_ordinal) is a
-- separate privilege and is untouched; `crm.phone_numbers` keeps its SELECT — dial
-- candidates resolve stored rows by E.164 for the payload's `phone_number_id`.

revoke select on crm.contacts from switchboard_crm;
grant select (id, tenant_id, display_name, channel, source, active,
              follow_up_interval_days, next_due_at, dial_rotation_ordinal,
              created_at, updated_at, linked_sheet_id, row_ref)
  on crm.contacts to switchboard_crm;

-- 🚨 NOTHING GRANTS `switchboard_agent` ANYTHING. Named only to be denied, in
-- 014/016/019/020/021's idiom — a no-op today, stated so the intent is legible in the
-- migration a reviewer reads and not only in a test.
revoke all on crm.contacts from switchboard_agent;
