// First Drive — one proposer cycle, through the REAL A2 door.
//
// 🚨 THIS IS THE FIRST NON-TEST CALLER `runCycle` HAS EVER HAD. Everything the proposer does
// was previously reachable only from vitest with an injected fake door. The point of this
// file is not convenience: it is that the door here is an HTTP POST to the running approval
// service, so 016's grant narrative and 014's idempotency key are exercised by the shipped
// path rather than by a test double.
//
// ONE SHOT, NOT THE SCHEDULER. `startScheduler` stays uncalled — a first drive that loops is
// a first drive you cannot observe. Run it, read the output, run it again if you want.
//
// DOOR ERRORS ARE FATAL HERE, DELIBERATELY. The door answers 201, 200 (duplicate), 409
// (terminal — the same key already reached a terminal state), 422 (payload mismatch), 429
// (cap or rate limit) and 503. A production loop must treat those as per-contact skips so one
// contact cannot stop the batch; this drive throws instead, because with one seeded contact a
// silent skip is indistinguishable from success and observation is the whole purpose.
// The status and body are always named in the error — a bare "request failed" would make the
// 409-after-rejection path (which is reachable from the second run onward) a mystery.
import { getCrmPool } from "../db.js";
import { runCycle, type DoorProposal } from "../proposer.js";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const USAGE =
  "usage:\n  crm-run-cycle [--tenant <uuid>] [--limit <n>]\n" +
  "env: CRM_DATABASE_URL, SWITCHBOARD_TENANT_ID, APPROVAL_URL, AGENT_PROPOSAL_TOKEN";

async function main(): Promise<void> {
  const tenant = arg("tenant") ?? process.env.SWITCHBOARD_TENANT_ID;
  const limit = Number(arg("limit") ?? "10");
  const base = process.env.APPROVAL_URL ?? "http://127.0.0.1:4009";
  const token = process.env.AGENT_PROPOSAL_TOKEN;

  if (!tenant) throw new Error(`SWITCHBOARD_TENANT_ID (or --tenant) is required\n${USAGE}`);
  if (!token) throw new Error(`AGENT_PROPOSAL_TOKEN is required\n${USAGE}`);
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit must be >= 1\n${USAGE}`);

  const db = getCrmPool();

  // The door, spoken to exactly as an agent host would speak to it.
  const postProposal = async (p: DoorProposal): Promise<{ id: string }> => {
    const res = await fetch(`${base}/internal/proposals`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(p),
    });
    const text = await res.text();
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`door refused ${p.action_type} (${res.status}): ${text}`);
    }
    const body = JSON.parse(text) as { id?: string };
    // The seam's contract is `{id}`. A 2xx without one means the door changed under us, and
    // returning undefined here would surface three frames later as a null constraint.
    if (!body.id) throw new Error(`door returned ${res.status} without an id: ${text}`);
    return { id: body.id };
  };

  try {
    const outcomes = await runCycle({ db, postProposal }, tenant, limit);
    if (outcomes.length === 0) {
      // NOT "nothing to do" — say which of the two it is, because a first drive that prints
      // a cheerful nothing is exactly the silent-empty failure this project keeps finding.
      console.log(
        `no contacts were claimed for tenant ${tenant}. Either none are due ` +
          `(next_due_at > now), or the tenant id does not match the seeded contact.`,
      );
      return;
    }
    for (const o of outcomes) {
      console.log(`contact ${o.contactId}`);
      for (const a of o.actions) {
        console.log(`  proposed ${a.channel}  proposal_id=${a.proposalId}`);
      }
      for (const s of o.skipped) {
        console.log(`  skipped  ${s.channel}: ${s.reason}`);
      }
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
