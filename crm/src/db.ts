// The CRM workspace's pool factory. Two entry points, two roles, and the difference is
// load-bearing (016's grant block, §I-3):
//
//   · `getOwnerPool()` — DATABASE_URL, the migration owner. What the OPERATOR CLIs connect
//     as (intake, question editor, settings), in 015:493-495's `approval-user-add`
//     precedent: human-invoked, interactive, not a service. `insert into crm.contacts` is
//     `42501` under the service role and that is correct.
//   · `getCrmPool()` — CRM_DATABASE_URL, `switchboard_crm`. What the PROPOSER and the
//     EXECUTOR connect as. It can write exactly the columns 016 lists and nothing else.
//
// Neither falls back to the other. A service that silently ran as the owner would void
// most of what 016's grant block buys, and the failure would be invisible.
import pg from "pg";

function poolFor(varName: string): pg.Pool {
  const url = process.env[varName];
  if (url === undefined || url === "") {
    throw new Error(
      `${varName} is required. This process will not fall back to another connection ` +
        `string: the role it connects as IS the privilege boundary (migration 016).`,
    );
  }
  const pool = new pg.Pool({ connectionString: url });
  pool.on("error", (err) => console.error("[crm] pool error:", err));
  return pool;
}

export const getOwnerPool = (): pg.Pool => poolFor("DATABASE_URL");
export const getCrmPool = (): pg.Pool => poolFor("CRM_DATABASE_URL");
