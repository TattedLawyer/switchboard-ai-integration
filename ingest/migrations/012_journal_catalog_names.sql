-- 012 — finish 011's rename in the catalog (sweep item 5, taken as a NEW migration).
--
-- 011 renamed ingest.outbox → ingest.ingest_journal, but a table rename does not touch
-- the objects hanging off it: the primary-key constraint/index kept `outbox_pkey` and
-- the id column's bigserial sequence kept `outbox_id_seq`. Cosmetic-but-real residue —
-- anyone reading the catalog meets a name 011 retired. Folding the fix INTO 011 was
-- ruled out live: 011's checksum is already recorded in a durable database, and editing
-- an applied migration is exactly what the tracking table refuses (migrate.ts throws on
-- drift). Hence 012.
--
-- Idempotence, house style (006's DO-block guards, 011's `if exists`): each statement
-- checks the OLD name exists before renaming, so the file is safe under re-run and
-- against any database where the objects already carry the new names. The constraint
-- rename uses ALTER TABLE … RENAME CONSTRAINT (renames constraint AND its underlying
-- index together, documented) rather than ALTER INDEX, which has no such coupling
-- guarantee across versions.

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'outbox_pkey' and conrelid = 'ingest.ingest_journal'::regclass
  ) then
    alter table ingest.ingest_journal rename constraint outbox_pkey to ingest_journal_pkey;
  end if;
end $$;

alter sequence if exists ingest.outbox_id_seq rename to ingest_journal_id_seq;
