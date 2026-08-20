-- 025 — card capture: the approval role gains EXACTLY the crm columns the capture
-- surface writes and reads, and nothing else moves.
--
-- WHY THIS MIGRATION EXISTS. Business-card capture is a HUMAN surface: the broker
-- photographs a card on her phone, confirms the extracted fields on the authenticated
-- dashboard, and the confirmed contact enters the follow-up loop. The only web-facing
-- role is `switchboard_approval` (014); until now it held NOTHING in schema `crm` —
-- contact creation belonged solely to the migration owner's operator CLIs (016's §I-3:
-- "human-invoked", `switchboard_crm` gets 42501 and that is pinned). A phone workflow
-- cannot be an owner CLI, so the approval role is granted the narrowest possible write:
-- column-level INSERT on the two capture tables, column-level SELECT to read back what
-- it wrote, and NO UPDATE, NO DELETE anywhere — a captured contact is created once and
-- then belongs to the loop's own roles.
--
-- THE GRANT DISCIPLINE IS 016/022's, restated:
--   · column-level, so a later `alter table add column` grants this role nothing by
--     accident;
--   · NO table-level UPDATE ever (016:479's warning: a table-level grant would make
--     later column-level revokes no-ops);
--   · `follow_up_interval_days` is DELIBERATELY ABSENT from the insert list — the
--     capture surface must not be ABLE to freeze an interval into the row. NULL means
--     "hers, at due-computation time" (crm/src/due.ts), and the cheapest way to keep
--     that true from a web surface is to make writing anything else impossible.
--
-- 🚨 `switchboard_agent` STILL HOLDS NOTHING. 016:499-501 and 022:44 already revoked the
-- agent from all of `crm`; nothing here grants it anything, and the restated revoke below
-- is a no-op by construction, kept because this file adds privileges to `crm` and must be
-- readable as evidence that the agent was not among the beneficiaries.

grant usage on schema crm to switchboard_approval;

-- crm.contacts — the columns `approval/src/card-capture.ts` inserts (the intake shape,
-- crm/src/intake.ts kept-in-sync) and reads back for the created page.
grant insert (tenant_id, display_name, email_address, channel, source, source_detail,
              looking_for, next_due_at)
  on crm.contacts to switchboard_approval;
grant select (id, tenant_id, display_name, email_address, channel, source, source_detail,
              looking_for, next_due_at, created_at)
  on crm.contacts to switchboard_approval;

-- crm.phone_numbers — insert with the intake invariants (E.164 dedupe, ordinal = the
-- order she entered them), select to dedupe within a submission and to render the
-- created page.
grant insert (contact_id, phone_e164, phone_raw, phone_region, label, ordinal)
  on crm.phone_numbers to switchboard_approval;
grant select (id, contact_id, phone_e164, phone_raw, phone_region, label, ordinal)
  on crm.phone_numbers to switchboard_approval;

-- No-op restatement of intent (see header): the agent gains nothing from this file.
revoke all on crm.contacts     from switchboard_agent;
revoke all on crm.phone_numbers from switchboard_agent;
