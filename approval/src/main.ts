// Phase 3 / A1 — the approval service entrypoint.
//
// Boots fail-closed and refuses to listen unless three things hold: every required
// variable is set, the connection authenticates as `switchboard_approval`, and the
// pending cap parses. The `current_user` check is the only one of these that catches a
// DEPLOYMENT mistake rather than a code mistake — an operator who points
// APPROVAL_DATABASE_URL at the migration owner gets a refusal naming the role, instead of
// a service that works perfectly while holding the credential able to re-grant the
// privilege the published claim rests on.
import pg from "pg";
import {
  approvalConnectionString,
  assertApprovalConfig,
  bindHost,
  pendingCap,
  proposalToken,
} from "./config.js";
import { createApprovalApp } from "./server.js";
import { startSweeper } from "./expiry.js";

export const REQUIRED_APPROVAL_ROLE = "switchboard_approval";

/** Refuses any connection not authenticating as the least-privilege approval role. */
export async function assertApprovalRole(db: pg.Pool | pg.PoolClient): Promise<void> {
  const res = await db.query("select current_user as who");
  const who = res.rows[0].who as string;
  if (who !== REQUIRED_APPROVAL_ROLE) {
    throw new Error(
      `approval service refuses to start: APPROVAL_DATABASE_URL authenticates as "${who}", ` +
        `not "${REQUIRED_APPROVAL_ROLE}". Connecting as the migration owner would give this ` +
        `service the ability to grant privileges to switchboard_agent — point it at the ` +
        `role migration 014 creates.`,
    );
  }
}

function resolveTenantId(): string {
  const raw = process.env.SWITCHBOARD_TENANT_ID ?? "00000000-0000-0000-0000-000000000000";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    throw new Error(`invalid SWITCHBOARD_TENANT_ID "${raw}": must be a uuid`);
  }
  return raw;
}

export async function main(): Promise<void> {
  assertApprovalConfig();
  const pool = new pg.Pool({ connectionString: approvalConnectionString() });
  await assertApprovalRole(pool);
  const tenantId = resolveTenantId();
  const app = createApprovalApp(pool, {
    tenantId,
    proposalToken: proposalToken(),
    pendingCap: pendingCap(),
  });
  // A2/T5 — one of expiry's THREE enforcement points, and the least important of them.
  // The door's cap count and the queue read query both filter on `expires_at`
  // independently, so a dead sweeper degrades promptness, not correctness. That is why it
  // logs its failures instead of taking the process down with it.
  startSweeper(pool, tenantId);
  const port = Number(process.env.APPROVAL_PORT ?? 4009);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid APPROVAL_PORT "${process.env.APPROVAL_PORT}"`);
  }
  const host = bindHost();
  app.listen(port, host, () => {
    console.log(`[approval] listening on ${host}:${port}`);
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
