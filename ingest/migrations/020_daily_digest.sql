-- 020: the daily-digest send ledger (the executor loop's digest phase).
--
-- WHY A NEW FILE. 014-019 are applied and checksum-enforced (src/migrate.ts): editing an
-- applied file makes `runMigrations` refuse. Everything here is new.
--
-- IMPLICITLY TRANSACTIONAL, in 015/016/019's idiom: `migrate.ts` submits this file as ONE
-- `client.query(sql)` and it contains no BEGIN/COMMIT.
--
-- WHAT THIS IS. One row per (tenant, LOCAL digest date): "the daily digest email for this
-- local date was sent". No existing state could carry that fact, and
-- `has_schema_privilege('switchboard_crm','crm','create')` is false — the service role
-- cannot invent its own table, which is correct and is why this migration exists.
--
-- 🚨 `digest_date` IS THE LOCAL DATE IN `crm.outreach_settings.timezone`, COMPUTED BY
-- POSTGRES (`(now() at time zone s.timezone)::date`), never by application code. 07:00
-- Manila is 23:00 UTC the PREVIOUS day; a JS-computed key sends the digest twice a day —
-- once at 07:00 Manila and again when UTC midnight flips the key. The digest phase
-- (`crm/src/digest.ts`) computes the date, the time gate and the already-sent check in one
-- statement and inserts the SAME returned date here.
--
-- APPEND-ONLY, matching 016's posture: SELECT and INSERT only, no UPDATE, no DELETE. The
-- primary key is the idempotency mechanism — a second daemon's duplicate send hits 23505
-- and is logged, not retried.
create table crm.digest_sends (
  tenant_id   uuid        not null,
  digest_date date        not null,
  sent_at     timestamptz not null default now(),
  primary key (tenant_id, digest_date)
);

-- `switchboard_crm` already holds USAGE on schema crm (016). The two verbs the digest
-- phase performs, and nothing more.
grant select, insert on crm.digest_sends to switchboard_crm;

-- Named only to be denied, in 014/016/019's idiom.
revoke all on crm.digest_sends from switchboard_agent;
revoke all on crm.digest_sends from switchboard_approval;
