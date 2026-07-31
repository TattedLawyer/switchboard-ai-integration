-- 008 — opaque-cursor persistence for feed-shaped sources whose position is an EVENT ID,
-- not a sequence number (Task B, stripe-feed connector).
--
-- ingest.cursors was born with `last_seq bigint` because the ledger feeds paginate by a
-- monotonic integer. A Stripe-style feed's cursor is the opaque id of the last event this
-- (tenant, source) actually processed — non-ordinal BY DESIGN, unstorable in a bigint.
-- Additive and idempotent: ledger-feed sources keep using last_seq and never read this
-- column; stripe-feed rows keep last_seq at its default 0 and never read THAT one. The
-- (tenant_id, source) key, RLS, and every existing read path are untouched.
alter table ingest.cursors add column if not exists last_event_id text;
