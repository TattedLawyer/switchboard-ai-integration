// Phase 3 / A2 — the operator surface for the one row class A2 deliberately cannot resolve.
//
// 🚨 WHY THIS FILE EXISTS. KNOWN-ISSUES accepts `executing` as a permanently non-terminal
// row class on the stated grounds that "A2 makes the state detectable by age
// (`findStuckExecutions`)". That function was exported and reachable from nowhere but a
// test — so the mitigation named in a published disclosure was not an operator surface at
// all, and an operator whose executor died mid-send had no shipped way to list the affected
// rows short of writing the query by hand. A disclosure that names a mitigation the
// operator cannot run is not a mitigation.
//
// 🚨 THIS TOOL DIAGNOSES AND DOES NOT ADJUDICATE, and that is the whole design. It will not
// move a row, because A2 cannot know whether a `started` row with no terminal sibling is a
// dead executor or a LIVE IN-FLIGHT SEND. A timer that flips a live send to `failed` is
// worse than a stuck row: the human authorised ONE send, and a mistaken `failed` invites a
// second. Deciding that needs the vendor's delivery semantics, which is A5's to know.
//
// Usage:
//   npm run stuck-executions -w approval            # older than 15 minutes
//   npm run stuck-executions -w approval -- --minutes 60
import pg from "pg";
import { approvalConnectionString } from "../config.js";
import { findStuckExecutions } from "../execute.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const raw = arg("minutes") ?? "15";
  const minutes = Number(raw);
  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    console.error(`invalid --minutes "${raw}": must be a non-negative integer`);
    process.exit(1);
  }
  // The approval role's own credential — SELECT is all this needs, and giving a diagnostic
  // the owner credential would hand it the ability to fix things it must not fix.
  const pool = new pg.Pool({ connectionString: approvalConnectionString() });
  try {
    const stuck = await findStuckExecutions(pool, minutes * 60);
    if (stuck.length === 0) {
      console.log(`no execution has been in flight for more than ${minutes} minute(s).`);
      return;
    }
    console.log(
      `${stuck.length} execution(s) started more than ${minutes} minute(s) ago with no ` +
        `recorded outcome:\n`,
    );
    for (const s of stuck) {
      console.log(
        `  proposal ${s.proposalId}  started ${s.startedAt}  age ${Math.round(s.ageSeconds / 60)}m`,
      );
    }
    console.log(
      "\nTHIS IS A DIAGNOSIS, NOT A VERDICT. Each of these is EITHER a send whose executor " +
        "died OR a send still in flight, and this tool cannot tell them apart — only the " +
        "vendor's delivery semantics can. Do NOT mark them failed and re-send without " +
        "checking the vendor for the proposal's idempotency key first: the human authorised " +
        "ONE send.",
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("stuck-executions failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
