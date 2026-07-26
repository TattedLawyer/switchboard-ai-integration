// A1 (least-privilege): the report/MCP pool connects as switchboard_agent, a role
// Postgres itself limits to SELECT on the analytics schema — so "read-only agent"
// is a database-enforced fact, not a naming convention. Production deployments set
// AGENT_DATABASE_URL explicitly; the derivation below is the local-dev convenience
// (same credential class as the committed docker-compose POSTGRES_PASSWORD).
export function agentConnectionString(): string {
  const explicit = process.env.AGENT_DATABASE_URL;
  if (explicit) return explicit;
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL or AGENT_DATABASE_URL is required");
  const url = new URL(base);
  url.username = "switchboard_agent";
  url.password = process.env.AGENT_DB_PASSWORD ?? "switchboard_agent";
  return url.toString();
}
