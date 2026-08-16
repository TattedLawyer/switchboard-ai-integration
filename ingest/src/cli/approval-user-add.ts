// Phase 3 / A2 — the operator path that bootstraps the approver list.
//
// WHY THIS EXISTS AT ALL, which is the part worth reading. `approval.decisions.
// approver_user_id` is a real foreign key into `approval.users`, and the approval service
// holds SELECT on that table and nothing else. So at merge the table is EMPTY and, without
// this tool, UNFILLABLE: the decisions INSERT raises 23503 and the transition to
// `approved` — the entire purpose of A2 — is unreachable in every real deployment. Every
// approval test would still pass, because a test harness connects as the migration owner
// and seeds users itself. That gap survived a full revision of the design precisely
// because the harness hid it.
//
// WHY NOT THE THREE OBVIOUS ALTERNATIVES:
//   · make A2 depend on A0b — then creating the table in A2 bought nothing;
//   · make `approver_user_id` nullable — that makes an unattributed approval
//     REPRESENTABLE, which `docs/adr/approver-identity.md:149-150` forbids in terms, and
//     it weakens the safety claim to buy a schedule;
//   · grant the approval service INSERT — a compromised service could then MINT an
//     approver who never existed. It can already forge an approval naming a REAL user (the
//     database authenticates nobody), so this is not categorical; but "the set of people
//     who can approve is not writable by the thing that records approvals" is a cheap
//     separation-of-duties property and worth keeping.
//
// So: an operator, with the owner credential, deliberately and rarely — the same shape as
// `gap-ack.ts`, which `approver-identity.md:151-156` already blesses as "an operator tool
// for an engineer". 🚨 That tool's attribution-not-authentication framing is correct FOR
// THAT ROLE and must NOT creep into the client-facing approval path: adding a row here
// gives someone a user id, it does not hand them a session. Since A0b, the row IS the
// admission ticket to magic-link login: /login sends a one-time link to EXACTLY this
// email address (exact byte equality — see migration 015's lower(email) warning), so the
// address entered here is the address that can sign in, and disabling the row is what
// revokes that.
//
// Usage:
//   node --import tsx src/cli/approval-user-add.ts --email <address>
//   node --import tsx src/cli/approval-user-add.ts --list
import { getPool } from "../db.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const USAGE =
  "usage:\n" +
  "  approval-user-add --email <address>\n" +
  "  approval-user-add --list";

async function main(): Promise<void> {
  const pool = getPool();
  try {
    if (has("list")) {
      const r = await pool.query<{ id: string; email: string; disabled_at: string | null }>(
        `select id, email, disabled_at from approval.users order by created_at`,
      );
      if (r.rowCount === 0) {
        console.log(
          "no approvers exist — no proposal in this deployment can be approved or rejected, " +
            "because a decision row must name one",
        );
      }
      for (const u of r.rows) {
        console.log(`${u.id}  ${u.email}${u.disabled_at ? "  [disabled]" : ""}`);
      }
      await pool.end();
      process.exit(0);
    }

    const email = arg("email");
    if (email === undefined || email.trim() === "" || email.startsWith("--")) {
      console.error("--email <address> is required: an approver without an address is not one");
      console.error(USAGE);
      await pool.end();
      process.exit(1);
    }

    // NO NORMALISATION, and that is deliberate. `lower()` is NOT identity-preserving for
    // mailboxes (U+212A lower-cases to `k`; U+0130 collides with `i`) and RFC 5321 §2.3.11
    // makes the local part case-sensitive and the mailbox owner's business. The address is
    // stored exactly as the operator typed it. The unique index on `lower(email)` is
    // STORAGE HYGIENE — it stops two rows that a human would read as the same person — and
    // it is never a comparison predicate anywhere in A2.
    try {
      const r = await pool.query<{ id: string; email: string }>(
        `insert into approval.users (email) values ($1) returning id, email`,
        [email],
      );
      console.log(`created approver ${r.rows[0].id}  ${r.rows[0].email}`);
      console.log(
        "they can now sign in by magic link at /login, using EXACTLY this address (byte-" +
          "for-byte — case variants do not resolve). If the deployment sends real mail, " +
          "the address must also be on SWITCHBOARD_EMAIL_ALLOWLIST or the link is refused.",
      );
    } catch (err) {
      // Never a silent success and never a silent no-op: an operator who believes they
      // added an approver and did not is the person debugging a 23503 later.
      if ((err as { code?: string }).code === "23505") {
        console.error(`an approver with this address already exists: ${email}`);
        await pool.end();
        process.exit(1);
      }
      throw err;
    }
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error("approval-user-add failed:", err);
    await pool.end();
    process.exit(1);
  }
}

main();
