// Operator CLI — capture a contact. Idiom from `ingest/src/cli/approval-user-add.ts`:
// human-invoked, rare, deliberate, and connecting as the MIGRATION OWNER (016 §I-3).
//
// Usage:
//   node --import tsx src/cli/crm-contact-add.ts --tenant <uuid> --channel call|email|both|none \
//        --source event|referral|manual [--name "Ana Reyes"] [--email ana@example.com] \
//        [--detail "Rotary breakfast"] [--looking-for "2BR near Alabang"] [--interval-days 30]
//
// `--name` IS OPTIONAL ON PURPOSE. A number with no name is still called; the agent
// introduces itself as an associate of the broker (§5.6). Refusing the capture would cost
// her the lead, which is the failure this product exists to fix.
import { getOwnerPool } from "../db.js";
import { addContact, type Channel, type Source } from "../intake.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}

const USAGE =
  "usage:\n  crm-contact-add --tenant <uuid> --channel call|email|both|none " +
  "--source event|referral|manual [--name <name>] [--email <address>] [--detail <text>] " +
  "[--looking-for <text>] [--interval-days <n>]";

async function main(): Promise<void> {
  const pool = getOwnerPool();
  try {
    const tenant = arg("tenant");
    const channel = arg("channel") as Channel | undefined;
    const source = arg("source") as Source | undefined;
    if (!tenant || !channel || !source) {
      console.error("--tenant, --channel and --source are all required");
      console.error(USAGE);
      await pool.end();
      process.exit(1);
    }
    const intervalRaw = arg("interval-days");
    const contact = await addContact(pool, {
      tenantId: tenant,
      displayName: arg("name") ?? null,
      emailAddress: arg("email") ?? null,
      channel,
      source,
      sourceDetail: arg("detail") ?? null,
      lookingFor: arg("looking-for") ?? null,
      followUpIntervalDays: intervalRaw === undefined ? null : Number(intervalRaw),
    });
    console.log(`created contact ${contact.id}`);
    console.log(
      `due now (${contact.nextDueAt.toISOString()}) — a newly captured lead is due ` +
        `immediately, which is the failure this replaces.`,
    );
    if (channel !== "none" && channel !== "email" && arg("name") === undefined) {
      console.log(
        "no name on file: the call still happens, opening with your nameless line, and " +
          "its answers are stored labelled identity-unverified.",
      );
    }
    if ((channel === "email" || channel === "both") && arg("email") === undefined) {
      console.log(
        "no email address yet: email follow-ups will be recorded BLOCKED and surfaced, " +
          "never silently dropped and never turned into a call. Add the address and the " +
          "next cycle proceeds.",
      );
    }
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error("crm-contact-add failed:", err);
    await pool.end();
    process.exit(1);
  }
}

main();
