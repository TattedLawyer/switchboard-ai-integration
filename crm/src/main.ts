// The proposer daemon — the CRM side of the unattended loop.
//
// Holds ONE credential: `switchboard_crm`. It never touches `approval.*` directly; the only
// way it reaches the spine is an HTTP POST through the A2 door, which is the whole point of
// the grant separation in 014/015/016.
//
// 🚨 IT DOES NOT CALL `runCycle`, AND THAT IS DELIBERATE. `runCycle` (`proposer.ts:110-121`)
// awaits `proposeForClaimed` sequentially and lets a throw propagate, so ONE contact that
// fails — a 409 terminal replay, a 422, a 429 at the pending cap, the approval service being
// down mid-batch — abandons every contact after it in the batch. In a one-shot CLI that is
// correct and loud. In a daemon it is a permanent starvation: `claimDue` returns contacts in
// a stable order, so the same contact aborts the same batch on every tick, forever, and the
// contacts behind it are leased and silently never proposed. `crm/src/cli/crm-run-cycle.ts`
// names this requirement and does not implement it, because a one-shot does not need it.
// So the cycle is composed HERE out of the same two shipped functions, with the per-contact
// boundary the daemon needs. Nothing is reimplemented: `claimDue` and `proposeForClaimed`
// are the shipped ones.
import pg from "pg";
import { getCrmPool } from "./db.js";
import { claimDue } from "./claim.js";
import { proposeForClaimed, type DoorProposal, type ProposerDeps } from "./proposer.js";
import { DoorReplyError } from "./door-reply.js";
import { startScheduler, CYCLE_INTERVAL_MS, CYCLE_BATCH } from "./scheduler.js";
import { loadSheetCycleContext } from "./sheet-read.js";
import { sheetTransportFromEnv, SHEETS_KEY_FILE_ENV } from "./sheet-client.js";

export const REQUIRED_CRM_ROLE = "switchboard_crm";

/** Refuses any connection not authenticating as the least-privilege proposer role. Mirrors
 *  `approval/src/main.ts`'s `assertApprovalRole`: without it, "holds only the CRM
 *  credential" is a claim nothing enforces, and an operator who points CRM_DATABASE_URL at
 *  the migration owner gets a daemon that works perfectly while holding privileges the
 *  design says it must never have. */
export async function assertCrmRole(db: pg.Pool): Promise<void> {
  const who = (await db.query<{ who: string }>("select current_user as who")).rows[0].who;
  if (who !== REQUIRED_CRM_ROLE) {
    throw new Error(
      `proposer refuses to start: CRM_DATABASE_URL authenticates as "${who}", not ` +
        `"${REQUIRED_CRM_ROLE}". Point it at the role migration 016 grants.`,
    );
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function main(): Promise<void> {
  const tenantId = required("SWITCHBOARD_TENANT_ID");
  const token = required("AGENT_PROPOSAL_TOKEN");
  const base = process.env.APPROVAL_URL ?? "http://127.0.0.1:4009";
  const intervalMs = Number(process.env.CRM_CYCLE_INTERVAL_MS ?? CYCLE_INTERVAL_MS);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) {
    throw new Error(`invalid CRM_CYCLE_INTERVAL_MS "${process.env.CRM_CYCLE_INTERVAL_MS}"`);
  }

  const db = getCrmPool();
  await assertCrmRole(db);

  // FAIL CLOSED AT BOOT, not on the first tick. Without an `outreach_settings` row
  // `proposeForClaimed` throws AFTER `claimDue` has already leased a batch, so the failure
  // mode is a 15-minute claim churn that logs and never proposes. Boot is the place to say
  // "she has not configured this yet" once, loudly, instead of once a minute forever.
  const settings = await db.query(
    "select 1 from crm.outreach_settings where tenant_id = $1",
    [tenantId],
  );
  if (settings.rowCount !== 1) {
    throw new Error(
      `no crm.outreach_settings row for tenant ${tenantId} — nothing may be proposed until ` +
        `the intervals and opening line are set. This is the end user's configuration, not ` +
        `a default for us to invent.`,
    );
  }

  const postProposal = async (p: DoorProposal): Promise<{ id: string }> => {
    const res = await fetch(`${base}/internal/proposals`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(p),
    });
    const text = await res.text();
    if (res.status !== 200 && res.status !== 201) {
      // 🚨 TYPED, so the STATUS survives to the proposer. `proposeForClaimed` converts a 422
      // fingerprint mismatch (a crashed cycle's retry whose bytes changed — Family 4) into a
      // surfaced blocked follow-up instead of a per-cycle throw loop; a bare `Error` here
      // would strip the status and leave that fix unreachable in the one process that runs
      // unattended. Everything else about this contract is unchanged: 409/422/429/5xx all
      // still throw, and the per-contact catch below still absorbs them.
      throw new DoorReplyError(res.status, `door refused ${p.action_type} (${res.status}): ${text}`);
    }
    const body = JSON.parse(text) as { id?: string };
    if (!body.id) throw new Error(`door returned ${res.status} without an id: ${text}`);
    return { id: body.id };
  };

  // The linked-sheet transport (Part 2). Null is "not configured" and must be LOUD at
  // boot, not silent: with a sheet linked, every sheet-bound contact skips each cycle
  // until the key file is set — a silently-absent sheet integration is the silence class
  // this repo names as its worst.
  const sheet = sheetTransportFromEnv();
  if (sheet === null) {
    console.log(
      `[crm] ${SHEETS_KEY_FILE_ENV} not set — the sheet integration is OFF. Contacts bound ` +
        `to a linked sheet will SKIP every cycle (details are read live from the sheet, ` +
        `never from stored copies); manual contacts run normally.`,
    );
  }

  const deps: ProposerDeps = { db, postProposal, sheet };

  const cycle = async (): Promise<void> => {
    const claimed = await claimDue(db, tenantId, CYCLE_BATCH, new Date());
    if (claimed.length === 0) return; // Quiet on purpose: 1,440 "nothing to do" lines a day
    // buries the lines that matter. Log work and state changes only.
    // 🚨 ONE SNAPSHOT PER TICK — the same cycle context for every claimed contact, one
    // Sheets API read however large the batch. An unavailable sheet is logged ONCE per
    // tick here; each affected contact then reports the skip in its own outcome.
    const sheetCtx = await loadSheetCycleContext(db, tenantId, sheet);
    if (sheetCtx.kind === "unavailable") {
      console.error(
        `[crm] linked sheet unavailable this cycle — sheet-bound contacts skip ` +
          `(no blocks, no clock changes; the claim lease retries them): ${sheetCtx.reason}`,
      );
    }
    let proposed = 0;
    let failed = 0;
    for (const c of claimed) {
      try {
        const outcome = await proposeForClaimed(deps, tenantId, c, sheetCtx);
        proposed += outcome.actions.length;
        for (const s of outcome.skipped) {
          console.log(`[crm] contact ${c.id}: skipped ${s.channel} — ${s.reason}`);
        }
      } catch (err) {
        // PER-CONTACT. The batch continues; the lease on this contact expires and the next
        // tick re-claims it. A repeating failure here is a real signal — it means one
        // contact is poisoned — so it is logged per contact with its id rather than as an
        // anonymous cycle failure.
        failed += 1;
        console.error(
          `[crm] contact ${c.id} failed (the batch continues, the lease re-claims it): ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
    console.log(
      `[crm] cycle: ${claimed.length} claimed, ${proposed} proposed, ${failed} failed`,
    );
  };

  // keepAlive: this loop IS the process. See scheduler.ts — the default unref exits in
  // under a tenth of a second.
  const stop = startScheduler(cycle, intervalMs, true);
  console.log(
    `[crm] proposer daemon running: tenant=${tenantId} every ${intervalMs}ms, ` +
      `batch=${CYCLE_BATCH}, door=${base}`,
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[crm] ${signal} — stopping after the current cycle`);
    stop();
    void db.end().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
