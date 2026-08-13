-- 017: one disposition value, so a sent email can be recorded honestly.
--
-- WHY A NEW FILE. 016 is applied and checksum-enforced (`ingest/src/migrate.ts:105-118`);
-- editing it makes `runMigrations` refuse. Everything here is new.
--
-- IMPLICITLY TRANSACTIONAL, in 015/016's idiom: `migrate.ts` submits this file as ONE
-- multi-statement simple query, which PostgreSQL wraps in an implicit transaction provided
-- the file contains no explicit BEGIN/COMMIT. It contains none and must never contain any.
--
-- WHY. Every one of 016:200-203's nine values is a CALL outcome. A successfully submitted
-- email had no honest value to write, and the only value that earns the long follow-up
-- interval (`crm/src/touch.ts:38`) is `'answered'` — which for an email is a FALSE STATEMENT
-- written into the audit trail of a system whose entire claim is that the trail is true.
-- `'sent'` is that missing value.
--
-- 🚨 `'sent'` MEANS SUBMISSION ACCEPTED BY THE RELAY. IT DOES NOT MEAN DELIVERED, AND NO
-- REPO DOCUMENT MAY DESCRIBE IT AS DELIVERY. Delivery is knowable only asynchronously, from
-- a bounce feed this system does not poll. `crm.touches` has no `delivered` column and must
-- never grow one until something actually observes delivery.
--
-- NO GRANT CHANGES. `switchboard_crm` already holds `insert` on `crm.touches` (016:466) and
-- column-level `update (disposition, ...)` (016:483-487). Widening a CHECK changes no
-- privilege. NOTHING HERE GRANTS `switchboard_agent` ANYTHING.
--
-- SINGLE-RUN BY THE LEDGER, NOT RE-ENTRANT, AND THAT IS FINE. `drop constraint if exists` +
-- `add constraint` is NOT re-entrant inside one database — a second `add` raises `42710`.
-- It never runs twice: `runMigrations` holds an advisory lock and skips files already
-- recorded in `ingest.schema_migrations` (`ingest/src/migrate.ts:86-130`), and each
-- `freshTestDb()` creates its OWN database, so nothing races this block.
--
-- `drop` + `add` rather than `add ... not valid`: the table is validated on the spot, so an
-- existing bad row would fail the migration loudly. That is the behaviour we want.

alter table crm.touches drop constraint if exists touches_disposition_check;

alter table crm.touches add constraint touches_disposition_check
  check (disposition in (
    'answered', 'partial', 'wrong_person',
    'voicemail', 'unknown_answer', 'no_answer',
    'busy', 'declined', 'failed',
    'sent'));
