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
  actionRateLimit,
  approvalConnectionString,
  approvalPublicUrl,
  assertApprovalConfig,
  bindHost,
  cookieInsecureDev,
  devSecretsAllowed,
  humanSurfaceEnabled,
  pendingCap,
  proposalToken,
  sessionSecret,
} from "./config.js";
import { createApprovalApp } from "./server.js";
import { startSweeper } from "./expiry.js";
import type { SendLoginLink } from "./login.js";

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

/** What a composition root may inject. `scripts/approval-service.ts` supplies the REAL
 *  link sender (the Postmark SMTP transport in `crm/src/email-transport.ts`) — it lives
 *  outside this workspace because 69ad456 closed cross-workspace src imports and the
 *  composition root is the one thing that must cross. */
export interface MainInjections {
  sendLoginLink?: SendLoginLink;
}

/** The ALLOW_DEV_SECRETS-only fallback: prints the link to the operator's terminal
 *  instead of mailing it. Loud about what it is, so a transcript cannot be mistaken for
 *  evidence that delivery works. */
const consoleLoginLink: SendLoginLink = async (to, url) => {
  console.log(`[approval] DEV LOGIN LINK (no mail was sent) for ${to}: ${url}`);
};

export async function main(inj: MainInjections = {}): Promise<void> {
  assertApprovalConfig();
  const pool = new pg.Pool({ connectionString: approvalConnectionString() });
  await assertApprovalRole(pool);
  const tenantId = resolveTenantId();

  // A0b — the human surface, opt-in and fail-closed. Every decision recorded through it
  // is attributed to the SESSION's user: the person who completed a magic-link login.
  // There is no operator-id configuration; APPROVAL_OPERATOR_USER_ID is gone.
  let human;
  if (humanSurfaceEnabled()) {
    const sendLoginLink = inj.sendLoginLink ?? (devSecretsAllowed() ? consoleLoginLink : undefined);
    if (!sendLoginLink) {
      throw new Error(
        "APPROVAL_HUMAN_SURFACE=1 but no login-link sender is available. Run the " +
          "composition root (scripts/approval-service.ts), which wires the real SMTP " +
          "transport — or set ALLOW_DEV_SECRETS=1 to print links to this terminal for " +
          "local demo use only. A login page whose links go nowhere is a lockout that " +
          "looks like a bug, so this refuses to boot instead.",
      );
    }
    human = {
      sessionSecret: sessionSecret(),
      cookieSecure: !cookieInsecureDev(),
      publicUrl: approvalPublicUrl(),
      sendLoginLink,
    };
  }

  const app = createApprovalApp(pool, {
    tenantId,
    proposalToken: proposalToken(),
    pendingCap: pendingCap(),
    actionRateLimit: actionRateLimit(),
    human,
  });
  if (human) {
    console.log(
      "[approval] human decision surface ENABLED at /queue — magic-link login, " +
        "database-backed sessions, CSRF defence (synchronizer token + Sec-Fetch-Site). " +
        "Decisions are attributed to the signed-in approver's user id, from the session.",
    );
    if (cookieInsecureDev()) {
      console.log(
        "[approval] ⚠️ APPROVAL_COOKIE_INSECURE=1 — the session cookie is NOT Secure and " +
          "NOT __Host-prefixed. Local plain-http development only; never a real deployment.",
      );
    }
  }
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
