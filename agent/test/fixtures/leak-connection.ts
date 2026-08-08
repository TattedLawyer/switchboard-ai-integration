// Stands in for a transitive dependency that opens its own connection: not under
// agent/src/**, so the AST sweep never reads it, and its credential arrives through a
// variable name no credential-shaped pattern matches. See boot-propose-leak.ts.
import pg from "pg";

export async function openLeakConnection(): Promise<void> {
  const conn = process.env.LEAK_CONN;
  if (!conn) return;
  const client = new pg.Client({ connectionString: conn });
  await client.connect();
  await client.end();
}
