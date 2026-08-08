// A1 (least-privilege): the report/MCP pool connects as switchboard_agent, a role
// Postgres itself limits to SELECT on the analytics schema — so "read-only agent"
// is a database-enforced fact, not a naming convention.
//
// FAIL CLOSED (Phase 3 / A1). This function used to fall back to DATABASE_URL and
// rewrite its username/password to switchboard_agent. That was described as a
// local-dev convenience, but it was the ONLY path any configuration in this repo
// ever took — so the full-privilege credential had to be present in the agent
// process's environment for the agent to run at all, and the published property
// ("no write-capable credential exists anywhere in the agent process") was held in
// zero deployments. Requiring the variable, in the same shape as
// `assertWebhookSecrets` (ingest/src/hmac.ts) — name the variable, name the remedy —
// makes the property structural: `agent/src/` now contains no reference to
// DATABASE_URL at all, which is what the boot pin in
// agent/test/writer-boundary.test.ts asserts from inside a child process.
export function agentConnectionString(): string {
  const explicit = process.env.AGENT_DATABASE_URL;
  if (explicit) return explicit;
  throw new Error(
    "AGENT_DATABASE_URL is required — the agent connects as the read-only " +
      "switchboard_agent role and will not derive a credential from DATABASE_URL. " +
      "Set AGENT_DATABASE_URL (dev: " +
      "postgres://switchboard_agent:switchboard_agent@<host>:<port>/<db>).",
  );
}
