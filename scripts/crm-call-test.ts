// Operator CLI — the ONE COMMAND that makes the first real phone call possible: seed a
// contact, a question set, an open outreach window, and an APPROVED `place_call` proposal,
// then tell the operator exactly what will happen and what to watch.
//
// Same relative-import exemption as `executor-loop.ts` and `drive-execute.ts`: 69ad456
// closed cross-workspace src imports on purpose, and this is a composition root — it wires
// the REAL approval functions (`payloadHash`, `placeCallPayloadSchema`, `decide`) into
// `crm/src/call-test.ts`'s injected spine, so it lives outside both tsconfigs. ALL LOGIC
// is in `crm/src/call-test.ts`, where the compiler and the pins can see it; this file only
// parses argv, parses the allowlist at the CLI edge, and prints.
//
// 🚨 IT REFUSES (in `seedCallTest`, before any write):
//   · a number not on SWITCHBOARD_PHONE_ALLOWLIST — fail-closed, by name;
//   · a database named `switchboard` — the executor-loop guard, copied on purpose.
//
// It connects as the MIGRATION OWNER (DATABASE_URL via `getOwnerPool`), like every other
// `crm-*` operator CLI (db.ts §I-3): seeding contacts, questions and settings is owner
// territory, and `42501` under `switchboard_crm` is correct.
//
// Usage:
//   npx tsx scripts/crm-call-test.ts --tenant <uuid> --phone "+639171234567" [--name "Ana"]
// env: DATABASE_URL, SWITCHBOARD_PHONE_ALLOWLIST
import { getOwnerPool } from "../crm/src/db.js";
import { parsePhoneAllowlist } from "../crm/src/call-guard.js";
import { seedCallTest, type CallTestSpine } from "../crm/src/call-test.js";
import { payloadHash } from "../approval/src/canonical.js";
import { decide } from "../approval/src/decide.js";
import { PROPOSAL_TTL_HOURS } from "../approval/src/config.js";
import { placeCallPayloadSchema } from "../approval/src/proposal.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i === -1 ? undefined : process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}

const USAGE =
  "usage:\n  npx tsx scripts/crm-call-test.ts --tenant <uuid> --phone <number> " +
  '[--name "Display Name"]\n' +
  "env: DATABASE_URL (migration owner), SWITCHBOARD_PHONE_ALLOWLIST (the number must be on it)";

// The REAL spine, wired here and only here — `crm/src` may not import `approval/src`.
const SPINE: CallTestSpine = {
  payloadHash,
  parsePayload: (input) => {
    const r = placeCallPayloadSchema.safeParse(input);
    return r.success
      ? { ok: true, value: r.data }
      : { ok: false, problem: r.error.issues.map((i) => i.path.join(".")).join("; ") };
  },
  decide: (pool, req) => decide(pool, req),
  proposalTtlHours: PROPOSAL_TTL_HOURS,
};

async function main(): Promise<void> {
  const tenant = arg("tenant");
  const phone = arg("phone");
  if (!tenant || !phone) {
    console.error("--tenant and --phone are both required");
    console.error(USAGE);
    process.exit(1);
  }

  // Parsed at the CLI EDGE, the call-guard doctrine: a malformed entry is a startup
  // failure here, never a silent mismatch at dial time.
  const allowlist = parsePhoneAllowlist(process.env.SWITCHBOARD_PHONE_ALLOWLIST);

  const pool = getOwnerPool();
  try {
    const seeded = await seedCallTest(pool, SPINE, {
      tenantId: tenant,
      phone,
      ...(arg("name") !== undefined ? { displayName: arg("name") as string } : {}),
      phoneAllowlist: allowlist,
    });

    console.log(`seeded and APPROVED a test call — proposal ${seeded.proposalId}`);
    console.log(``);
    console.log(`WHAT WILL HAPPEN`);
    console.log(`  · contact ${seeded.contactId} ("${arg("name") ?? "Call Test"}")`);
    console.log(`  · number  ${seeded.phoneE164} (phone_number ${seeded.phoneNumberId})`);
    console.log(`  · opening line, spoken verbatim: ${JSON.stringify(seeded.openingLine)}`);
    console.log(
      `  · questions (${seeded.questionPrompts.length}${
        seeded.questionSetCreated ? ", minimal set published — she had none" : ", HER current set, reused"
      }):`,
    );
    for (const q of seeded.questionPrompts) console.log(`      - ${q}`);
    console.log(
      `  · outreach window ${seeded.window.start}–${seeded.window.end} ${seeded.window.timezone}` +
        (seeded.windowAdjusted
          ? " (WIDENED to be open now — her window was closed; restore it after the test)"
          : seeded.settingsCreated
            ? " (created — no settings row existed)"
            : " (hers, already open)"),
    );
    console.log(
      `  · the proposal is 'approved' (decision by ${seeded.approverUserId}, ` +
        `call-test-operator@example.com) and expires ${seeded.expiresAt.toISOString()}`,
    );
    console.log(``);
    console.log(`WHAT TO WATCH`);
    console.log(
      `  1. A RUNNING executor daemon (npx tsx scripts/executor-loop.ts) picks it up on its` +
        ` next tick via selectApprovedActions. Its startup banner tells you which transport` +
        ` is live:`,
    );
    console.log(
      `       · "Call transport LIVE via LiveKit …" + a running voice-agent worker ⇒ the` +
        ` phone ACTUALLY RINGS (${seeded.phoneE164} is on SWITCHBOARD_PHONE_ALLOWLIST — it` +
        ` was checked here, and the executor and the transport each check it again).`,
    );
    console.log(
      `       · "Call transport STUB — no phone rings" ⇒ a rehearsal: the canned no-answer` +
        ` (SIP 480) is recorded, nobody is dialled.`,
    );
    console.log(
      `  2. In the daemon log: "[exec] executed ${seeded.proposalId} (call) touch=… disposition=…".`,
    );
    console.log(
      `  3. In the database: the touch row (crm.touches, proposal_id above) and, on a live` +
        ` answered call, crm.answers rows committed DURING the call.`,
    );
    console.log(
      `  4. If the daemon dies mid-call the proposal stays 'executing' — that is the` +
        ` designed wedge; \`npm run reconcile -w crm\` lists it. Do not re-approve.`,
    );
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error("crm-call-test refused:", err instanceof Error ? err.message : err);
    await pool.end();
    process.exit(1);
  }
}

main();
