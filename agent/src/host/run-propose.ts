// Phase 3 / A1 — the agent's proposal path, as a bootable entrypoint.
//
// This exists so the boundary can be TESTED end to end rather than described. The A1 boot
// pin (agent/test/writer-boundary.test.ts) boots THIS, not run-report.ts: run-report never
// proposes anything, so booting it would have been a true assertion about an irrelevant
// path — the exact vacuity this repo keeps rediscovering.
//
// What the path does, in the order that matters:
//   1. Build the agent's ONLY pool, from AGENT_DATABASE_URL, and refuse unless the live
//      connection authenticates as switchboard_agent.
//   2. Produce a proposal object. (In A2 this is the model's output; today it is argv, so
//      the boundary is exercisable without an API key.)
//   3. Hand it to the approval service, which records it. No SQL happens in this process.
//
// The absence in step 3 is the design: there is no writer pool to reach for.
import pg from "pg";
import { agentConnectionString, assertAgentRole } from "./agent-db.js";
import { recordProposal } from "./propose.js";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

export async function main(): Promise<void> {
  // Step 1. Constructed and checked even though the proposal below does not read the mart:
  // the pin is that the proposal path holds the read-only credential AND NO OTHER, and a
  // path that never opened a connection would prove nothing about which one it holds.
  const pool = new pg.Pool({ connectionString: agentConnectionString(), max: 1 });
  try {
    await assertAgentRole(pool);

    // Step 2.
    const proposal = {
      idempotencyKey: arg("key") ?? `run-propose-${Date.now()}`,
      actionType: arg("action") ?? "send_email",
      payload: JSON.parse(arg("payload") ?? '{"to":"ops@example.com"}') as Record<
        string,
        unknown
      >,
      rationale: arg("rationale") ?? "proposed by the agent host's A1 proposal path",
    };

    // Step 3. Throws if the door did not record it — never a plausible-looking success.
    const recorded = await recordProposal(proposal);
    console.log(
      `recorded proposal ${recorded.id} (state=${recorded.state}` +
        `${recorded.duplicate ? ", duplicate" : ""})`,
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
