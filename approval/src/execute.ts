// Phase 3 / A2 — the execution guard. At-most-once, enforced by the database.
//
// 🚨 THESE ARE TYPESCRIPT FUNCTIONS, NOT SQL ONES, AND THAT IS DELIBERATE. "At-most-once
// lives in Postgres" means the CONSTRAINT lives in Postgres — the partial unique index
// `executions_one_start` — not that the workflow does. A SQL `approval.begin_execution()`
// would be created with `proacl` NULL, i.e. PUBLIC-executable by default, and the pin that
// watches this schema for exactly that would red with nothing to fix except the function's
// own existence. If you ever do add a SQL function here, revoke PUBLIC EXECUTE on it in
// the same migration: nothing automatic protects it, and the two "belts" that were
// supposed to were both measured inert on PG 16.
//
// WHAT A2 SHIPS AND WHAT IT DOES NOT. A2 ships the GUARD. It does not ship a sender: the
// vendor is an interface here, stubbed, and C5 builds the real one. Two acceptance
// criteria travel to C5 with it and are not A2 assumptions:
//   · whether the provider HONOURS the idempotency key we propagate;
//   · that the executor derives the ENTIRE outbound message from the bound payload, and
//     that any field it synthesises is either constant per deployment or displayed on the
//     card. A2 does NOT bind the payload to the SMTP envelope — everything between the
//     canonical payload and what the recipient receives is outside anything A2 guarantees.
//
// 🚨 `executing` HAS NO TIMER-DRIVABLE EXIT, AND A2 DELIBERATELY BUILDS NO REAPER. A row
// whose executor died mid-send stays `executing` forever: the sweeper must not move it,
// `executing -> approved` is correctly forbidden (that is the retry loop that
// double-sends), and only a live executor writes `executed` / `execution_failed` — which
// "A5 decides what to do" cannot deliver if A5 IS the process that died. A timer that
// flips a live in-flight send to `failed` is WORSE than a stuck row, so A2 does three
// things and stops: it records the start time, it makes the state queryable BY AGE
// (`findStuckExecutions` below), and it hands the reaper CONTRACT to A5, which will know
// the vendor's delivery semantics. This is not a cap wedge — `executing` rows sit outside
// the pending count — but if A5 never writes that contract, these rows accumulate
// silently. That is recorded in KNOWN-ISSUES, not just here.
import type pg from "pg";

export class ExecutionRefused extends Error {}

export interface StartedExecution {
  executionId: string;
  idempotencyKey: string;
}

/**
 * Claim a proposal for execution. Exactly one caller can win.
 *
 * The `started` row goes in FIRST, so the database's partial unique index decides the race
 * before any state is moved. A read-then-write in application code would lose that race
 * under exactly the conditions it exists to handle.
 */
export async function beginExecution(
  pool: pg.Pool,
  proposalId: string,
): Promise<StartedExecution> {
  const client = await pool.connect();
  try {
    await client.query("begin");

    // The key we will hand the vendor is the one the human's ask was recorded under, so a
    // retry at the vendor is the same logical send. (Whether the vendor honours it is a C5
    // acceptance criterion.)
    const p = await client.query<{ idempotency_key: string; state: string }>(
      `select idempotency_key, state from approval.proposals where id = $1`,
      [proposalId],
    );
    if (p.rowCount !== 1) {
      await client.query("rollback");
      throw new ExecutionRefused(`no such proposal: ${proposalId}`);
    }

    const ins = await client.query<{ id: string }>(
      `insert into approval.executions (proposal_id, kind, idempotency_key)
       values ($1, 'started', $2)
       returning id`,
      [proposalId, p.rows[0].idempotency_key],
    );

    // Only now the state moves — conditionally, with `approved` AND the validity window
    // in the predicate.
    //
    // 🚨 `and expires_at > now()` IS THE POINT-OF-USE CHECK, AND ITS ABSENCE WAS A REAL
    // DEFECT. This comment used to claim "an expired approval fails HERE" while the
    // predicate contained no expiry term at all — measured, `beginExecution` on an approval
    // that expired an hour earlier SUCCEEDED. The only thing standing between a stale
    // authorisation and a send was the sweeper having run first; the sweeper lives in the
    // approval service on a 60s timer while the executor is A5 in a different process, and
    // `expiry.ts` argues in terms that a sweeper alone fails open during exactly the outage
    // that matters.
    //
    // The normative sources all put the obligation on the VERIFIER AT THE MOMENT OF USE:
    // RFC 7519 §4.1.4 and RFC 9068 §4 make it a MUST on the party accepting the token;
    // RFC 6749 §10.5 makes the single-use consent artifact refuse at REDEMPTION; RFC 5280
    // §6.1 makes the current time an INPUT to path validation rather than a stored flag;
    // and NIST SP 800-63B says an expiry marker "SHALL NOT be depended upon to enforce
    // session timeouts" — which is precisely what a sweeper-only design does.
    //
    // WHY IT LIVES IN THE UPDATE PREDICATE RATHER THAN IN A PRECEDING `select`: this makes
    // it a COMPARE-AND-SET. The check and the use cannot be separated by any interleaving,
    // which is Chubby's sequencer discipline ("the recipient server is expected to test
    // whether the sequencer is still valid… if not, it should reject the request") and
    // RFC 6749's single-use property, in one clause. A read-then-act would reintroduce the
    // window it exists to close.
    //
    // The sweeper is NOT redundant — it keeps the pending cap and the queue read honest —
    // but it is bookkeeping, and this is enforcement.
    const upd = await client.query(
      `update approval.proposals set state = 'executing'
        where id = $1 and state = 'approved' and expires_at > now()`,
      [proposalId],
    );
    if (upd.rowCount !== 1) {
      await client.query("rollback");
      // The message names BOTH possible causes: reporting only the state would produce a
      // baffling "it is 'approved'" refusal for a row that is approved and expired.
      const why = await client.query<{ state: string; expired: boolean }>(
        `select state, expires_at <= now() as expired from approval.proposals where id = $1`,
        [proposalId],
      );
      const row = why.rows[0];
      throw new ExecutionRefused(
        `proposal ${proposalId} cannot be executed: state is '${row?.state ?? "gone"}'` +
          `${row?.expired ? " and its approval EXPIRED — the human's authorisation is no longer valid" : ""}` +
          ". Nothing was started and nothing was retried.",
      );
    }

    await client.query("commit");
    return { executionId: ins.rows[0].id, idempotencyKey: p.rows[0].idempotency_key };
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Record the outcome. Appends a terminal execution row and moves the proposal.
 *
 * `execution_failed` is TERMINAL FOR A2. What to do about it — retry policy, budgets,
 * circuit breakers, re-proposal — is A5's, deliberately: A2 has no basis for deciding
 * whether a given vendor failure is safe to retry.
 */
export async function finishExecution(
  pool: pg.Pool,
  proposalId: string,
  outcome: { ok: boolean; vendorReference?: string; error?: string },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // 🚨 THE ROWCOUNT IS CHECKED, because this is an insert-SELECT and a missing `started`
    // row makes it a silent no-op. Without the check the transaction still committed the
    // state move, producing a proposal marked `executed` with an EMPTY execution log — the
    // audit trail saying an action happened with no record of it happening. Reachable
    // whenever something reached `executing` outside `beginExecution`, which the INSERT
    // forgery (C-1) made possible.
    const logged = await client.query(
      `insert into approval.executions
         (proposal_id, kind, idempotency_key, vendor_reference, error)
       select $1, $2, e.idempotency_key, $3, $4
         from approval.executions e
        where e.proposal_id = $1 and e.kind = 'started'`,
      [
        proposalId,
        outcome.ok ? "succeeded" : "failed",
        outcome.vendorReference ?? null,
        outcome.error ?? null,
      ],
    );
    if (logged.rowCount !== 1) {
      await client.query("rollback");
      throw new ExecutionRefused(
        `proposal ${proposalId} has no 'started' execution row, so there is no execution to ` +
          "finish. The outcome was NOT recorded and the state was NOT moved — a terminal " +
          "state with an empty execution log would be an action claimed with no evidence.",
      );
    }
    const upd = await client.query(
      `update approval.proposals set state = $2
        where id = $1 and state = 'executing'`,
      [proposalId, outcome.ok ? "executed" : "execution_failed"],
    );
    if (upd.rowCount !== 1) {
      await client.query("rollback");
      throw new ExecutionRefused(
        `proposal ${proposalId} was not 'executing' — the outcome was NOT recorded.`,
      );
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface StuckExecution {
  proposalId: string;
  startedAt: string;
  ageSeconds: number;
}

/**
 * A `started` row with no terminal sibling, older than `minAgeSeconds`.
 *
 * THIS IS DETECTION, NOT ADJUDICATION. It answers "which sends might have died?" and
 * deliberately does not answer "which of them failed?" — that is the question A5 gets to
 * answer, with knowledge of the vendor's delivery semantics that A2 does not have.
 */
export async function findStuckExecutions(
  db: pg.Pool | pg.PoolClient,
  minAgeSeconds: number,
): Promise<StuckExecution[]> {
  const res = await db.query<{ proposal_id: string; at: string; age_seconds: string }>(
    `select s.proposal_id, s.at, extract(epoch from (now() - s.at)) as age_seconds
       from approval.executions s
      where s.kind = 'started'
        and s.at <= now() - make_interval(secs => $1::int)
        and not exists (
          select 1 from approval.executions t
           where t.proposal_id = s.proposal_id
             and t.kind in ('succeeded', 'failed')
        )
      order by s.at`,
    [minAgeSeconds],
  );
  return res.rows.map((r) => ({
    proposalId: r.proposal_id,
    startedAt: r.at,
    ageSeconds: Number(r.age_seconds),
  }));
}
