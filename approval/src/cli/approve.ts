// Operator CLI — decide a proposal from a terminal.
//
// 🚨 WHY THIS EXISTS RATHER THAN "just use /queue". The browser surface has no login and no
// CSRF defence (see `human.ts`), which was acceptable only while a stub sender made an
// approval inert. The moment real SMTP is wired, a forged cross-site POST becomes "sends a
// real email as the operator". This CLI is how a human decides in the window between the
// transport landing and the session work landing: a local process is not a cross-site
// request forgery target, because there is no browser and no ambient credential to ride.
//
// It is NOT a lesser path. It goes through the same `decide()` — same transaction boundary,
// same 015 trigger, same append-only decision row with a real `approver_user_id`. What it
// skips is the HTML, not the accountability.
//
// 🚨 IT DOES NOT COLLAPSE DUPLICATES. `approveCard`/`rejectCard` dispose of byte-identical
// repeats behind one card; deciding a lone id here leaves any repeats pending, which fails
// toward asking the human again rather than toward a second outward action. Stated so the
// difference from the page is a known limitation and not a surprise.
// Its own pool, not `ingest`'s `getPool` — 69ad456's exports guard makes that import a
// compile error (TS6059), and rightly: this workspace does not depend on that one.
import pg from "pg";
import { decide, DecisionRefused } from "../decide.js";
import { readPendingQueue } from "../queue.js";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const USAGE =
  "usage:\n" +
  "  approve --list\n" +
  "  approve --id <proposal-uuid> --as <approver-user-uuid>\n" +
  "  approve --id <proposal-uuid> --as <approver-user-uuid> --reject --reason <text>\n" +
  "env: DATABASE_URL, SWITCHBOARD_TENANT_ID";

async function main(): Promise<void> {
  const tenantId = process.env.SWITCHBOARD_TENANT_ID;
  if (!tenantId) throw new Error(`SWITCHBOARD_TENANT_ID is required\n${USAGE}`);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error(`DATABASE_URL is required\n${USAGE}`);
  const pool = new pg.Pool({ connectionString: url });

  try {
    if (process.argv.includes("--list")) {
      const rows = await readPendingQueue(pool, tenantId);
      if (rows.length === 0) {
        // Never a bare blank. An empty queue and a misconfigured tenant look identical.
        console.log(
          `no live pending proposals for tenant ${tenantId}. That is either nothing ` +
            `proposed, everything decided, or everything expired unseen.`,
        );
        return;
      }
      for (const r of rows) {
        console.log(`${r.id}  ${r.action_type}  expires ${new Date(r.expires_at).toISOString()}`);
        console.log(`    payload:   ${JSON.stringify(r.payload)}`);
        console.log(`    rationale: ${r.rationale}`);
      }
      return;
    }

    const id = arg("id");
    const approver = arg("as");
    const reject = process.argv.includes("--reject");
    const reason = arg("reason");
    if (!id || !approver) throw new Error(USAGE);

    const result = await decide(pool, {
      proposalId: id,
      kind: reject ? "rejected" : "approved",
      approverUserId: approver,
      ...(reason ? { reason } : {}),
    });
    console.log(`${reject ? "rejected" : "approved"} ${id} — ${JSON.stringify(result)}`);
  } catch (err) {
    if (err instanceof DecisionRefused) {
      console.error(`refused: ${err.message}`);
      process.exit(2);
    }
    throw err;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
