-- 016: the core follow-up loop (`.superpowers/sdd/core-loop-plan.md` rev 5, §T2).
--
-- WHY A NEW FILE. 014 and 015 are applied and checksum-enforced (`src/migrate.ts:105-118`):
-- editing an applied file makes `runMigrations` refuse, because at that point the database
-- and the repository disagree about what schema exists. Everything here is new.
--
-- IMPLICITLY TRANSACTIONAL, in 015's idiom. `migrate.ts` submits this file as ONE
-- `client.query(sql)` — a multi-statement simple query, which PostgreSQL wraps in an
-- implicit transaction provided the file contains no explicit BEGIN/COMMIT. It contains
-- none and must never contain any: the create-then-revoke of the two trigger functions is
-- only safe because no window exists between them.
--
-- WHAT THIS IS. A broker's leads arrive from networking events and referrals; she takes a
-- phone number; follow-up does not happen and the lead goes cold. This schema is the
-- MEMORY that makes step 2 of the loop — "who is due today" — a query rather than a
-- recollection. It rides the A2 approval spine that already exists; it builds no second
-- one.
--
-- THREE ARTIFACTS, THREE HOMES (plan §0), and none is derived from another at read time:
--   · structured ANSWERS to her questions — stored, keyed to the question asked;
--   · a short SUMMARY — stored, length-capped by a CHECK, marked generated;
--   · the full TRANSCRIPT — emailed to her, NEVER STORED. There is no transcript column in
--     this file and there must never be one.
--
-- THE CLAIM LEASE IS 15 MINUTES and it is NOT in this file as a callable object. The due
-- query's `next_due_at = now() + interval '15 minutes'` claim (plan §T6) is a lease that
-- stops a second proposer for the length of one cycle — it is NOT a follow-up interval and
-- must never be confused with one; `recordTouch` owns the real clock and is the only thing
-- that ever writes a follow-up interval. The constant lives in `crm/src/due.ts`
-- (`CLAIM_LEASE_MINUTES`) rather than in a SQL function, because 015:509-518 forbids this
-- repo's migrations from creating any callable SQL function beyond trigger functions: such
-- a function is created with `proacl` NULL, i.e. PUBLIC-executable by default.

-- ---------------------------------------------------------------------------------------
-- THE ROLE.
-- ---------------------------------------------------------------------------------------
--
-- `switchboard_crm` is the role the EXECUTOR and the PROPOSER connect as. It is named here
-- (rev 4's plan said "the CRM role" and never named one) so every grant below is against a
-- role the design chose.
--
-- Idempotent and concurrency-safe in the idiom of 005/006/014: parallel ephemeral-database
-- test migrations race this block.
do $$
begin
  if not exists (select from pg_roles where rolname = 'switchboard_crm') then
    -- LOCAL DEV CREDENTIAL, same class as the committed docker-compose POSTGRES_PASSWORD
    -- and 014's. Set only at creation, so a production `alter role ... password` is never
    -- reset by re-migration. Production supplies CRM_DATABASE_URL.
    create role switchboard_crm login password 'switchboard_crm';
  end if;
exception
  when duplicate_object then null; -- lost a create race to a parallel migration: fine
end
$$;

create schema if not exists crm;

-- ---------------------------------------------------------------------------------------
-- CONTACTS.
-- ---------------------------------------------------------------------------------------
--
-- NO PHONE COLUMN. A contact has MANY numbers (plan §0 decision 3), with no mobile/landline
-- distinction and no inferred type at all — see `crm.phone_numbers`.
--
-- NO BUDGET / AREA / TIMELINE COLUMNS. Rev 1 had them; they were the hardcoded outcome
-- schema, and the owner's decision replaced them with HER question list. Her questions are
-- the schema now (`crm.questions` / `crm.answers`), so a hardcoded outcome column would be
-- a second, stale, competing answer store.
create table if not exists crm.contacts (
  id                      uuid primary key default gen_random_uuid(),
  -- One deployment serves one configured tenant (SEC-C1), carried so no row is tenant-blind.
  tenant_id               uuid        not null,
  -- NULLABLE, and the whole nameless-call path (plan §5.6) rests on that. A number with no
  -- name still gets called; the agent introduces itself as an associate of the broker.
  -- Every condition in this design is `display_name is null`, never `= ''`.
  display_name            text        null,
  email_address           text        null,
  -- THE PER-PROSPECT CONTROL, and it is a channel rather than on/off (owner decision 2).
  -- `none` is enforced as a QUERY PREDICATE in the due query, not as a UI setting.
  channel                 text        not null
                                      check (channel in ('call', 'email', 'both', 'none')),
  source                  text        not null
                                      check (source in ('event', 'referral', 'manual')),
  source_detail           text        null,
  looking_for             text        null,
  active                  boolean     not null default true,
  -- NULL means "use the tenant default AT DUE-COMPUTATION TIME". Deliberately not
  -- backfilled with the default at insert: backfilling would freeze today's setting into
  -- the row, so a later change to her default would silently stop applying to everyone
  -- captured before it.
  follow_up_interval_days integer     null check (follow_up_interval_days is null
                                                  or follow_up_interval_days > 0),
  -- A newly captured lead is due IMMEDIATELY — that is the client's stated failure.
  next_due_at             timestamptz null,
  -- Which number the next cycle proposes. The list rotates ACROSS cycles, never within one
  -- (plan §5.1): an approved proposal names ONE number in an immutable payload, so dialling
  -- a second mid-execution would place a call the human never approved.
  dial_rotation_ordinal   integer     not null default 0 check (dial_rotation_ordinal >= 0),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists contacts_due
  on crm.contacts (tenant_id, next_due_at)
  where active and channel <> 'none';

-- ---------------------------------------------------------------------------------------
-- PHONE NUMBERS.
-- ---------------------------------------------------------------------------------------
--
-- 🚨 `unique (contact_id, phone_e164)` — DELIBERATELY NOT UNIQUE PER TENANT, and this is a
-- design decision with a name. A global unique index would encode the falsehood
-- FALSEHOODS.md names outright: "A phone number uniquely identifies an individual" is
-- FALSE — households and relatives share numbers. Two contacts may hold the same number;
-- CONTACTS ARE NEVER MERGED ON NUMBER EQUALITY, and there is no identity resolution here.
--
-- NO TYPE COLUMN, no `is_mobile`, no `is_valid`. FALSEHOODS.md: "Don't store properties for
-- a phone number such as validity or type." `crm/src/phone.ts` refuses to compute them.
--
-- NO OWNERSHIP MODELLING of any kind — no "who owns this number" column, no inference, no
-- confidence score. Reaching the right person is a CONVERSATIONAL problem (plan §5.2/§5.5):
-- the agent asks.
create table if not exists crm.phone_numbers (
  id          uuid primary key default gen_random_uuid(),
  contact_id  uuid        not null references crm.contacts (id),
  phone_e164  text        not null,
  -- What she typed, byte for byte. The only thing that lets her recognise her own entry.
  phone_raw   text        not null,
  phone_region text       not null default 'PH',
  -- Free text, FOR HER EYES ONLY ("office", "husband"). The machine never reads it — dial
  -- order is `ordinal`, the order she entered them.
  label       text        null,
  ordinal     integer     not null check (ordinal >= 0),
  added_at    timestamptz not null default now(),
  constraint phone_numbers_one_per_contact unique (contact_id, phone_e164)
);

create index if not exists phone_numbers_by_contact on crm.phone_numbers (contact_id, ordinal);

-- ---------------------------------------------------------------------------------------
-- HER QUESTION LIST. Immutable, versioned.
-- ---------------------------------------------------------------------------------------
--
-- The call is a PRE-PROGRAMMED QUESTION LIST SHE EDITS, not an open conversation (owner
-- decision 1). Editing a question creates a NEW VERSION and retires the old one, so an
-- answer recorded in March still resolves to March's wording after a June edit. Rewriting
-- in place would silently restate what a prospect was actually asked.
create table if not exists crm.question_sets (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid        not null,
  version    integer     not null check (version > 0),
  created_at timestamptz not null default now(),
  retired_at timestamptz null,
  constraint question_sets_one_per_version unique (tenant_id, version)
);

create table if not exists crm.questions (
  id          uuid primary key default gen_random_uuid(),
  set_id      uuid        not null references crm.question_sets (id),
  ordinal     integer     not null check (ordinal >= 0),
  -- A STABLE SLUG, carried forward verbatim across versions. This is what makes
  -- "every answer to this question, across every version" a query rather than a join
  -- through wording. Unique within a set.
  question_key text       not null,
  -- The wording actually used, per version.
  prompt_text text        not null check (length(btrim(prompt_text)) > 0),
  -- A RENDERING HINT, NEVER A VALIDATOR. "around 5, maybe 6" is stored verbatim against a
  -- numeric-kind question; coercing it would be exactly the guessing this design removed.
  answer_kind text        not null check (answer_kind in ('text', 'number', 'yes_no', 'date')),
  constraint questions_key_unique_in_set unique (set_id, question_key),
  constraint questions_ordinal_unique_in_set unique (set_id, ordinal)
);

-- ---------------------------------------------------------------------------------------
-- TOUCHES — one row per attempted contact.
-- ---------------------------------------------------------------------------------------
--
-- 🚨 THE ROW IS INSERTED AT CALL START, not at end of call (plan §T2/I1). Forced by the
-- schema: `crm.answers.touch_id` is a FK and answers are committed DURING the call, so the
-- parent must already exist. `transcript_delivery` is written `'pending'` HERE, before the
-- call is even placed, which is what converts the "crash between summarising and sending"
-- path from SILENT loss into VISIBLE loss (T13's reconcile lists it). It does not recover
-- the transcript. Nothing can.
--
-- 🚨 `proposal_id` IS DELIBERATELY NOT A FOREIGN KEY into `approval.proposals`. A
-- cross-schema FK requires a REFERENCES privilege on the approval table, quietly widening
-- the surface 014:79-90 exists to keep narrow. The link is by id, unenforced; T13's
-- reconcile detects a dangling one. No repo doc may describe it as an enforced foreign key.
create table if not exists crm.touches (
  id                          uuid primary key default gen_random_uuid(),
  contact_id                  uuid        not null references crm.contacts (id),
  channel                     text        not null check (channel in ('call', 'email')),
  proposal_id                 uuid        null,
  phone_number_id             uuid        null references crm.phone_numbers (id),
  question_set_id             uuid        null references crm.question_sets (id),
  -- NULL until the call ends. See the trigger note below: the disposition is NULL for the
  -- WHOLE call, which is why the `crm.answers` INSERT trigger cannot be the load-bearing
  -- guard.
  disposition                 text        null check (disposition in (
                                            'answered', 'partial', 'wrong_person',
                                            'voicemail', 'unknown_answer', 'no_answer',
                                            'busy', 'declined', 'failed')),
  -- How far down her list we got. Distinguishes "never asked" from "asked and declined":
  -- an unreached question simply has no answer row.
  reached_ordinal             integer     null check (reached_ordinal is null
                                                      or reached_ordinal >= 0),
  -- A message passed to a THIRD PARTY. She needs to know one is outstanding so a call two
  -- days later does not look odd. Deliberately does NOT change the clock — one fewer knob
  -- she has to invent, and the signal is visible either way.
  message_left                boolean     not null default false,
  -- 🚨 A DATA-QUALITY FACT, NOT A DISPOSITION, and NEVER read by either trigger. Answers
  -- from a nameless call came from SOMEONE AT THAT NUMBER and we do not know who. Refusing
  -- data we KNOW is wrong (`wrong_person`) is correct; refusing data we merely cannot
  -- attribute would delete the entire nameless path, which the owner explicitly chose.
  identity_unverified         boolean     not null default false,
  summary                     text        null,
  summary_state               text        null check (summary_state in ('generated', 'failed')),
  summary_generated_at        timestamptz null,
  transcript_email_message_id text        null,
  transcript_email_sent_at    timestamptz null,
  transcript_email_subject    text        null,
  -- 🚨 `pending` IS A MEMBER. Rev 2 wrote `('sent','failed')` while the mitigation for the
  -- crash path REQUIRED writing `'pending'` — the reviewer measured `23514`, i.e. the single
  -- named mitigation could not be written and the reconcile pin could never go green.
  transcript_delivery         text        null
                                          check (transcript_delivery in ('pending', 'sent', 'failed')),
  occurred_at                 timestamptz not null default now(),
  -- THE 1200-CHARACTER CAP IS JUDGMENT (~200 words, one scannable screen) and is a CEILING,
  -- NOT A TARGET. It is a DB CHECK rather than an app validation deliberately: the app is
  -- the thing that drifts, and a model that ignores its length instruction must get a
  -- `23514` rather than a quietly growing column. A silently truncated summary reads as
  -- complete, which is worse than a refusal.
  constraint touches_summary_capped check (summary is null or length(summary) <= 1200),
  -- 🚨 REVIEW I-5. Makes `wrong_person + identity_unverified` UNREPRESENTABLE rather than
  -- merely unreachable. The combination is incoherent: `wrong_person` means we ASKED and
  -- were told this is not the contact; `identity_unverified` means we never asked. This
  -- CHECK NARROWS `wrong_person` and cannot widen it onto the nameless path.
  constraint touches_wrong_person_is_identified
    check (not (disposition = 'wrong_person' and identity_unverified))
);

create index if not exists touches_by_contact on crm.touches (contact_id, occurred_at desc);
create index if not exists touches_transcript_pending
  on crm.touches (occurred_at) where transcript_delivery = 'pending';

-- ---------------------------------------------------------------------------------------
-- ANSWERS — append-only.
-- ---------------------------------------------------------------------------------------
--
-- A changed answer APPENDS a second row; current state is the later one and both remain
-- readable. No UPDATE grant and no DELETE grant exists anywhere for this table, so
-- "append-only" is a privilege fact, not a convention.
--
-- Keyed to `question_id` (a VERSION), never to `question_key`: that is what makes an answer
-- recorded in March still resolve to March's wording.
create table if not exists crm.answers (
  id          uuid primary key default gen_random_uuid(),
  touch_id    uuid        not null references crm.touches (id),
  question_id uuid        not null references crm.questions (id),
  -- VERBATIM. No coercion, ever, whatever `answer_kind` says.
  value       text        not null,
  at          timestamptz not null default now()
);

create index if not exists answers_by_touch on crm.answers (touch_id, at);

-- ---------------------------------------------------------------------------------------
-- THE `wrong_person` GUARD — TWO TRIGGERS, because in the ordering we actually ship the
-- disposition is NULL for the whole call.
-- ---------------------------------------------------------------------------------------
--
-- 🚨 REVIEW B-A. Rev 3 justified a SINGLE `before insert on crm.answers` trigger with "the
-- disposition is already set when any answer would arrive." THAT SENTENCE WAS ONLY EVER
-- TRUE OF AN ORDERING WE DO NOT SHIP, and rev 4's own I1 fix is what made it false: the
-- touch is inserted at call start with a NULL disposition and the disposition is written at
-- call end. The reviewer executed it with only that trigger installed — answers inserted
-- against the NULL-disposition touch (`INSERT 0 1`), then `set disposition='wrong_person'`
-- succeeded (`UPDATE 1`). The forbidden state existed and nothing raised. The justification
-- sentence is deleted, not softened.
--
-- WHAT THE EXECUTOR DOES WHEN THE UPDATE TRIGGER RAISES: the identity failure wins — those
-- answers must never be kept — so THE APPLICATION MUST NOT HAVE WRITTEN THEM. It marks the
-- touch `wrong_person` the moment identity fails and writes no further answers. THE TRIGGER
-- IS A BACKSTOP THAT MAKES AN APPLICATION BUG LOUD INSTEAD OF SILENT, not the primary
-- mechanism. A raise here is a defect to fix, not a condition to handle.
--
-- BOTH PREDICATE ON `disposition = 'wrong_person'` AND ON NOTHING ELSE. Neither reads
-- `identity_unverified` (plan §5.7). A nameless call's disposition is `answered` /
-- `partial` / `no_answer` / …, so both predicates are false and its answers insert
-- normally. Extending either trigger to cover identity-unverified touches would silently
-- delete the entire nameless path — the outcome the owner explicitly rejected.
create or replace function crm.answers_no_wrong_person() returns trigger
language plpgsql as $$
declare
  d text;
begin
  select t.disposition into d from crm.touches t where t.id = new.touch_id;
  if d = 'wrong_person' then
    raise exception 'answers may not be recorded against a wrong_person touch'
      using detail = 'the person who answered told us they are not the contact, so nothing '
                     'they said is an answer from the contact.';
  end if;
  return new;
end
$$;

-- Immediately after the create, in the same implicit transaction, so there is no window.
-- A trigger function is created with `proacl` NULL, i.e. PUBLIC-executable by default;
-- revoking PUBLIC EXECUTE does not stop the trigger firing.
revoke execute on function crm.answers_no_wrong_person() from public;

create or replace function crm.touches_no_wrong_person_with_answers() returns trigger
language plpgsql as $$
begin
  if new.disposition = 'wrong_person'
     and exists (select 1 from crm.answers a where a.touch_id = new.id) then
    raise exception 'a touch with answers may not be dispositioned wrong_person'
      using detail = 'the answers were recorded before identity failed; they are not the '
                     'contact''s answers and must not be kept. The executor must mark the '
                     'touch wrong_person at the moment identity fails and write no further '
                     'answers — this trigger is a backstop, not a condition to handle.';
  end if;
  return new;
end
$$;

revoke execute on function crm.touches_no_wrong_person_with_answers() from public;

create trigger answers_no_wrong_person
  before insert on crm.answers
  for each row execute function crm.answers_no_wrong_person();

create trigger touches_no_wrong_person_with_answers
  before update on crm.touches
  for each row execute function crm.touches_no_wrong_person_with_answers();

-- `ENABLE ALWAYS`, per 015:466-467's precedent. A trigger created the ordinary way has
-- `pg_trigger.tgenabled = 'O'` and does not fire when `session_replication_role = replica`
-- — exactly the sort of plausible-looking setting someone wires up for a bulk-load tool.
-- DISCLOSED COST, identical to 015's: if these tables are ever a logical-replication
-- subscriber, apply of a legitimate row will RAISE. Refusing to apply beats silently
-- accepting an unguarded row.
alter table crm.answers enable always trigger answers_no_wrong_person;
alter table crm.touches enable always trigger touches_no_wrong_person_with_answers;

-- ---------------------------------------------------------------------------------------
-- FOLLOW-UPS.
-- ---------------------------------------------------------------------------------------
--
-- 🚨 REVIEW B4 — THE OPEN-GUARD EXCLUDES BLOCKED ROWS, and rev 2's version of this index
-- produced the exact failure the mechanism was built to prevent. With the guard written
-- `(contact_id) where closed_at is null`, nothing ever closed a blocked row and nothing
-- COULD (there was no UPDATE grant): she sets Ana to `email`, has not typed the address
-- yet, cycle 1 writes the blocked row, she adds the address that afternoon — and cycles
-- 2..∞ are suppressed FOREVER. The anti-silence mechanism became a permanent silencer.
--
-- `unique (contact_id, due_date)` provides the once-per-due-date suppression the
-- deterministic idempotency key was chosen for.
--
-- 🚨 THE RECOVERY PATH IS EXPLICIT AND IT IS CLOSING LOGIC. When the block condition lifts,
-- the proposer UPDATEs the EXISTING `(contact_id, due_date)` row, clearing `blocked_reason`.
-- It must not insert a second row: the reviewer measured `23505 follow_ups_one_per_due` on
-- that path. Rev 4's "no closing logic to forget" is DELETED — there is closing logic, it is
-- one UPDATE, and a pin is what stops anyone forgetting it. Without it the blocked row
-- stays open forever and T13's reconcile accretes one stale entry per blocked contact per
-- cycle — a listing that only accretes rows nobody can action, which is the exact trap
-- plan §5.2 rejects by name.
create table if not exists crm.follow_ups (
  id             uuid primary key default gen_random_uuid(),
  contact_id     uuid        not null references crm.contacts (id),
  due_date       date        not null,
  -- The anti-silence record. A preference we cannot honour must be SURFACED, never
  -- silently dropped and never overridden by falling back to another channel: overriding
  -- her stated preference at the moment we have least information is the worst available
  -- outcome.
  blocked_reason text        null,
  closed_at      timestamptz null,
  created_at     timestamptz not null default now(),
  constraint follow_ups_one_per_due unique (contact_id, due_date)
);

create unique index if not exists follow_ups_one_open
  on crm.follow_ups (contact_id)
  where closed_at is null and blocked_reason is null;

create table if not exists crm.follow_up_actions (
  id           uuid primary key default gen_random_uuid(),
  follow_up_id uuid        not null references crm.follow_ups (id),
  channel      text        not null check (channel in ('call', 'email')),
  -- Unenforced link, same reasoning as `crm.touches.proposal_id`.
  proposal_id  uuid        null,
  created_at   timestamptz not null default now(),
  constraint follow_up_actions_one_per_channel unique (follow_up_id, channel)
);

-- ---------------------------------------------------------------------------------------
-- OUTREACH SETTINGS — one row per tenant.
-- ---------------------------------------------------------------------------------------
--
-- 🚨 THE TWO INTERVALS HAVE NO DEFAULT, deliberately. A default here would imply we learned
-- something we did not — the same discipline that left A2's pending cap at 100. They are
-- owner decisions 1 and 2 and the insert REFUSES rather than inventing a number.
--
-- 🚨 REVIEW I-4 — `not null` DOES NOT REFUSE `''`, and rev 4 claimed it did. The reviewer
-- inserted both opening lines empty and a placeholder-free `opening_line`; ALL WERE
-- ADMITTED. §5.6's "the insert refuses when either line is empty" was PROSE, NOT SCHEMA. An
-- empty `opening_line_no_name` means the agent opens a nameless call WITH SILENCE — the
-- worst possible first impression on a referral lead, which is her entire lead source.
create table if not exists crm.outreach_settings (
  tenant_id            uuid primary key,
  -- The outreach window. Evaluated at EXECUTION time in `timezone`, never at proposal time:
  -- approval on Tuesday does not make a Thursday call permitted. Manila has no DST.
  window_start         time        not null,
  window_end           time        not null,
  timezone             text        not null default 'Asia/Manila',
  -- THE NAMED PATH. Contains `{name}`, substituted with `contacts.display_name` at PROPOSAL
  -- time, so the fully-rendered line is what she sees on the card and what the immutable
  -- payload binds (015:353-363). She approves the exact words that will be spoken; nothing
  -- is templated at call time.
  opening_line         text        not null,
  -- THE NAMELESS PATH (owner, rev 4): "if the number has no name just introduce yourself as
  -- an associate of the end user." No placeholder is required and none is invented. The
  -- wording is HERS, not a sentence we wrote.
  opening_line_no_name text        not null,
  default_interval_days integer    not null check (default_interval_days > 0),
  short_retry_days      integer    not null check (short_retry_days > 0),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint outreach_settings_opening_line_usable
    check (length(btrim(opening_line)) > 0 and opening_line like '%{name}%'),
  constraint outreach_settings_opening_line_no_name_usable
    check (length(btrim(opening_line_no_name)) > 0)
);

-- ---------------------------------------------------------------------------------------
-- GRANTS. Table by table, in 014/015's precedent, so every pin is against a grant the
-- design chose rather than one an implementer happened to write.
-- ---------------------------------------------------------------------------------------
--
-- WHICH ROLE RUNS WHAT (plan §T2/I-3), because rev 4 named this role and then never said
-- who does the writes it CANNOT do:
--
--   · the intake / question-editor / settings CLIs run as the MIGRATION OWNER, like every
--     existing operator CLI (015:493-495's `approval-user-add` precedent). Human-invoked,
--     interactive, not a service. `insert into crm.contacts` etc. are `42501` under
--     `switchboard_crm` and that is correct.
--   · the EXECUTOR runs as `switchboard_crm`. The column grants below cover exactly its
--     writes.
--   · the PROPOSER runs as `switchboard_crm` for `crm.*` AND USES THE A2 DOOR'S BEARER
--     TOKEN for proposals. 🚨 IT DOES NOT INSERT INTO `approval.proposals` AT ALL — it POSTs
--     to the door (`approval/src/server.ts:135`), exactly as any agent does. That is the
--     whole point of `proposal.ts`'s "the agent has a credential to a door that writes on
--     its behalf", and it keeps every word of this grant block earned. CONSEQUENCE,
--     DISCLOSED: the claim/follow_ups write and the proposal creation are NOT ATOMIC. A
--     crash between them leaves a claimed contact with no proposal — the case T13's
--     reconcile lists first, self-healing in 15 minutes via the claim lease.
--
-- B2 WAS A REAL, VERIFIED BREAK: rev 2 granted `select, insert` only, and the reviewer
-- measured `42501` on `crm.touches` and `crm.follow_ups` — so EVERY post-call write (the
-- clock, the close, the summary, the delivery status) failed on the first real call. The
-- column lists below are EXHAUSTIVE BY DESIGN: a column not listed cannot be written, which
-- is what makes the "42501 outside the grant" pin non-vacuous.
grant usage on schema crm to switchboard_crm;

grant select, insert on crm.touches           to switchboard_crm;
grant select, insert on crm.answers           to switchboard_crm;
grant select, insert on crm.follow_ups        to switchboard_crm;
grant select, insert on crm.follow_up_actions to switchboard_crm;

grant select on crm.contacts          to switchboard_crm;
grant select on crm.phone_numbers     to switchboard_crm;
grant select on crm.questions         to switchboard_crm;
grant select on crm.question_sets     to switchboard_crm;
grant select on crm.outreach_settings to switchboard_crm;

-- COLUMN-LEVEL updates only — the shipped 015:481 idiom, NEVER table-level. Two subtleties,
-- both load-bearing: "any nontrivial UPDATE will require SELECT privilege as well" (already
-- granted above), and "the table-level grant is unaffected by a column-level operation" —
-- so if TABLE-level UPDATE is ever granted here, later column-level REVOKEs do nothing.
grant update (next_due_at, updated_at, dial_rotation_ordinal) on crm.contacts to switchboard_crm;

grant update (disposition, reached_ordinal, message_left, identity_unverified,
              summary, summary_state, summary_generated_at,
              transcript_delivery, transcript_email_message_id,
              transcript_email_sent_at, transcript_email_subject)
  on crm.touches to switchboard_crm;

-- The recovery path (B-B) needs exactly these two and no more.
grant update (closed_at, blocked_reason) on crm.follow_ups to switchboard_crm;

-- Nothing else. NO DELETE ANYWHERE. NO GRANT OPTION ANYWHERE. `crm.answers` in particular
-- holds neither UPDATE nor DELETE, which is what makes it append-only in fact.

-- 🚨 NOTHING GRANTS `switchboard_agent` ANYTHING, directly or transitively. Named here only
-- to be denied, in 014:90's idiom, so the intent is legible in the migration a reviewer
-- reads and not only in a test. This is a no-op today (it was never granted) — and it was
-- OMITTED from rev 2, which is why B5(a) exists.
revoke all on schema crm from switchboard_agent;
revoke all on all tables in schema crm from switchboard_agent;
revoke all on all functions in schema crm from switchboard_agent;
