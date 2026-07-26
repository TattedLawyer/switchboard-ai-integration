-- 005: least-privilege agent role (hardening wave A1).
-- The report/MCP pool must not share the app role: "read-only agent" has to be a
-- property Postgres enforces, not a naming convention. The role is cluster-wide,
-- created idempotently and concurrency-safe (parallel ephemeral-DB test migrations
-- race this block). Schema grants are NOT here: the analytics schema name is runtime
-- config (DBT_SCHEMA), and migration files are static — see grantAgentReadOnly() in
-- src/migrate.ts. The role deliberately gets no grant on raw/ingest at all.
--
-- The password below is the LOCAL DEV credential (same class as the committed
-- docker-compose POSTGRES_PASSWORD). It is set only at creation time, so a production
-- ALTER ROLE password change is never reset by re-migration; production should
-- connect the agent via AGENT_DATABASE_URL.
do $$
begin
  if not exists (select from pg_roles where rolname = 'switchboard_agent') then
    create role switchboard_agent login password 'switchboard_agent';
  end if;
exception
  when duplicate_object then null; -- lost a create race to a parallel migration: fine
end
$$;
