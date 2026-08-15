-- 018: one disposition value, so an asynchronous refusal can be recorded honestly.
--
-- WHY A NEW FILE. 017 is applied and checksum-enforced (`ingest/src/migrate.ts:105-118`);
-- editing it makes `runMigrations` refuse. Everything here is new — the same one-line
-- widening idiom as 017, for the same reason 017 could not edit 016.
--
-- IMPLICITLY TRANSACTIONAL, in 015/016/017's idiom: `migrate.ts` submits this file as ONE
-- multi-statement simple query, which PostgreSQL wraps in an implicit transaction provided
-- the file contains no explicit BEGIN/COMMIT. It contains none and must never contain any.
--
-- WHY. Postmark's SMTP endpoint answers 250 when it accepts a message FOR PROCESSING and
-- may refuse it afterwards; the refusal appears only in the bounce feed. `'sent'` remains
-- TRUE when that happens — the submission WAS accepted — so the refusal needs its own row
-- and its own word. `'failed'` is already taken: it is a call-transport outcome
-- (`resolveDisposition`), and overloading it would make "the dial failed" and "the relay
-- reneged after accepting" indistinguishable in the one trail whose entire claim is that
-- it is true.
--
-- 🚨 `'bounced'` MEANS THE RELAY ACCEPTED THE SUBMISSION AND LATER REFUSED TO DELIVER IT.
-- It is APPENDED as a NEW touch by the bounce reconciler (`crm/src/bounces.ts`) — the
-- existing `'sent'` touch is never amended, because it is not false. It is not in
-- `LONG_INTERVAL_DISPOSITIONS` (`crm/src/touch.ts`), so recording it moves the contact to
-- the SHORT retry: the cycle's contact did not happen, and the clock must say so.
--
-- NO GRANT CHANGES. `switchboard_crm` already holds `insert` on `crm.touches` (016:466)
-- and column-level `update (disposition, ...)` (016:483-487). Widening a CHECK changes no
-- privilege. NOTHING HERE GRANTS `switchboard_agent` ANYTHING.
--
-- SINGLE-RUN BY THE LEDGER, NOT RE-ENTRANT, AND THAT IS FINE — 017's reasoning, unchanged:
-- `runMigrations` holds an advisory lock and skips recorded files, and each `freshTestDb()`
-- creates its own database.
--
-- `drop` + `add` rather than `add ... not valid`: the table is validated on the spot, so an
-- existing bad row would fail the migration loudly. That is the behaviour we want.

alter table crm.touches drop constraint if exists touches_disposition_check;

alter table crm.touches add constraint touches_disposition_check
  check (disposition in (
    'answered', 'partial', 'wrong_person',
    'voicemail', 'unknown_answer', 'no_answer',
    'busy', 'declined', 'failed',
    'sent', 'bounced'));
