// Phase 3 / A1 — the approval service's HTTP surface.
//
// Today it mounts exactly one route: the internal door the agent host posts proposals to.
// A0b's remaining half — the client's login, session and approval page — mounts on this
// same app later; that is the whole reason the writer lives here rather than in the agent
// process (the service exists regardless, so the marginal deployment cost of keeping the
// agent credential-free is zero processes).
//
// The door is INTERNAL. It is loopback-bound by default (config.ts `bindHost`) and
// authenticated by a bearer secret. It is not, and must never become, a client-facing
// route: a human approver's authority is a different thing from an agent's authority to
// ask, and merging them would let a compromised agent host approve its own proposal.
import express from "express";
import { timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { parseProposal } from "./proposal.js";
import { payloadHash } from "./canonical.js";
import {
  ACTION_RATE_WINDOW_MINUTES,
  DEFAULT_ACTION_RATE_LIMIT,
  PROPOSAL_TTL_HOURS,
  TERMINAL_PROPOSAL_STATES,
} from "./config.js";

export interface ApprovalAppOptions {
  /** A2/T10 — the per-action-type rate limit. See config.ts: a runaway backstop ranked
   *  THIRD behind repeat-suppression and expiry, with a JUDGMENT number and no source. */
  actionRateLimit?: number;
  /** SEC-C1: the ONE tenant this deployment writes under, resolved at boot and passed
   *  explicitly — so a tenant-less door is a compile error, not a nil-tenant write. */
  tenantId: string;
  proposalToken: string;
  pendingCap: number;
}

/** Constant-time bearer comparison. Length is compared first because timingSafeEqual
 *  throws on a length mismatch — and length is not the secret. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createApprovalApp(pool: pg.Pool, opts: ApprovalAppOptions): express.Express {
  const app = express();

  // Order is the control, not a style choice (the same registration-order reasoning
  // ingest/src/server.ts documents for B8): authentication is registered BEFORE the body
  // parser, so an unauthenticated caller never reaches the parser at all and cannot use a
  // malformed body to distinguish "wrong token" from "no such route".
  const requireBearer = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void => {
    const header = req.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!presented || !tokenMatches(presented, opts.proposalToken)) {
      // Never names the expected value, never distinguishes "absent" from "wrong": both
      // are the same answer to the caller, and the difference is only useful to a guesser.
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };

  const jsonParser = express.json({ limit: "256kb" });
  const parserErrors = (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void => {
    if (err && typeof err === "object" && "type" in err) {
      res.status(400).json({ error: "malformed request body" });
      return;
    }
    next(err);
  };

  app.get("/status", (_req, res) => {
    res.json({ ok: true, service: "approval" });
  });

  app.post(
    "/internal/proposals",
    requireBearer,
    jsonParser,
    parserErrors,
    async (req: express.Request, res: express.Response) => {
      const parsed = parseProposal(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: "invalid proposal", details: parsed.errors });
        return;
      }
      const proposal = parsed.value;

      try {
        // FLOOD CONTROL, half two. Counted before the insert and enforced here rather than
        // by a database constraint, because the cap is a policy about queue triageability
        // and a human's attention — not an invariant of the row. Read-then-insert is
        // racy under concurrency by construction; the race can overshoot the cap by the
        // number of concurrent posters, which for a single agent host is bounded and
        // acceptable. Saying so beats implying an exactness this does not have.
        // A2/T5 — THE COUNT IS VALIDITY-FILTERED, and that is what makes the wedge heal.
        // Before A2 this counted every pending row forever, so one burst 429'd the door
        // PERMANENTLY, legitimate proposals included: nothing could move a pending row to
        // a terminal state. An expired row is genuinely dead — the sweeper will restate
        // it and the queue read hides it — so holding cap budget for it is holding budget
        // for nothing.
        //
        // 🚨 THE FILTER IS DUPLICATED HERE ON PURPOSE, not centralised into the sweeper.
        // A sweeper alone fails open during exactly the outage that matters; this clause
        // heals the queue with NO process running at all.
        //
        // The numeral is unchanged (100) and the comment in config.ts says why it must
        // now be read differently: it counts UNEXPIRED pending rows, a different quantity
        // under the same number.
        const pending = await pool.query(
          `select count(*)::int as n from approval.proposals
            where tenant_id = $1 and state = 'pending' and expires_at > now()`,
          [opts.tenantId],
        );
        if ((pending.rows[0].n as number) >= opts.pendingCap) {
          // LOUD, and 429 rather than 503: the queue is full of real pending work, which
          // is an operator/approver condition, not a transient failure to retry blindly.
          res.status(429).json({
            error: "pending proposal cap reached",
            pending: pending.rows[0].n,
            cap: opts.pendingCap,
            remedy:
              "an approver must triage the pending queue; raise PENDING_PROPOSAL_CAP only " +
              "if a human can actually keep up with the higher number",
          });
          return;
        }

        // A2/T4. The hash is computed here, over the CANONICAL serialisation, and it has
        // EXACTLY ONE JOB: telling a retry of the same call apart from a different
        // proposal reusing a key. It is not a TOCTOU control, not a display binding, and
        // it is not what makes the payload immutable — that is the column grant and the
        // trigger in migration 015.
        const canonicalHash = payloadHash(proposal.payload);

        // A2/T10 — PER-ACTION RATE LIMIT. Ranked below repeat-suppression and expiry, and
        // it is a bound on how fast a compromised agent host can fill the queue with ONE
        // KIND of action, not a claim about anyone's attention. Counted over a rolling
        // window and over EVERY state, deliberately: a burst that has already been
        // triaged still happened, and the thing being limited is the agent's production
        // rate, not the queue's depth (that is the cap's job, and the cap is the weakest
        // of the three).
        const rateLimit = opts.actionRateLimit ?? DEFAULT_ACTION_RATE_LIMIT;
        const recent = await pool.query(
          `select count(*)::int as n from approval.proposals
            where tenant_id = $1 and action_type = $2
              and created_at > now() - make_interval(mins => $3::int)`,
          [opts.tenantId, proposal.action_type, ACTION_RATE_WINDOW_MINUTES],
        );
        if ((recent.rows[0].n as number) >= rateLimit) {
          res.status(429).json({
            error: "per-action proposal rate limit reached",
            action_type: proposal.action_type,
            limit: rateLimit,
            window_minutes: ACTION_RATE_WINDOW_MINUTES,
            remedy:
              "the agent is producing this action faster than the limit allows. Raise " +
              "PROPOSAL_ACTION_RATE_LIMIT only if the higher rate is one a human can " +
              "actually decide on; the usual right answer is to narrow the action.",
          });
          return;
        }

        // FLOOD CONTROL, half one. `on conflict do nothing` + a follow-up read makes a
        // replay a no-op at the DATABASE (the unique index) rather than at the door, so a
        // second poster racing the first cannot produce two rows. Returns the ORIGINAL
        // id, because an idempotent call must be indistinguishable from its first attempt
        // to a caller that retried after a timeout.
        const ins = await pool.query(
          `insert into approval.proposals
             (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash,
              expires_at)
           values ($1, $2, $3, $4::jsonb, $5, $6,
                   now() + make_interval(hours => $7::int))
           on conflict (tenant_id, idempotency_key) do nothing
           returning id, state, payload`,
          [
            opts.tenantId,
            proposal.idempotency_key,
            proposal.action_type,
            JSON.stringify(proposal.payload),
            proposal.rationale,
            canonicalHash,
            PROPOSAL_TTL_HOURS,
          ],
        );
        if (ins.rowCount === 1) {
          // WHICH BYTES ARE AUTHORITATIVE. The stored bytes must BE the hashed bytes, or
          // `payload_hash` describes something other than the row it sits on. So the door
          // re-hashes what the database returned and refuses LOUDLY on divergence rather
          // than shipping a row whose hash is about a different object. (T1 pins the
          // equivalence directly; this is the runtime half, and it has never fired.)
          const storedHash = payloadHash(ins.rows[0].payload as Record<string, unknown>);
          if (storedHash !== canonicalHash) {
            throw new Error(
              "payload hash diverged across the insert: the stored bytes are not the " +
                `hashed bytes (sent ${canonicalHash.slice(0, 12)}..., stored ` +
                `${storedHash.slice(0, 12)}...)`,
            );
          }
          res.status(201).json({ id: ins.rows[0].id, state: ins.rows[0].state });
          return;
        }

        const existing = await pool.query(
          `select id, state, payload_hash from approval.proposals
            where tenant_id = $1 and idempotency_key = $2`,
          [opts.tenantId, proposal.idempotency_key],
        );
        const row = existing.rows[0] as { id: string; state: string; payload_hash: string };

        // SAME KEY, DIFFERENT PAYLOAD — 422, and NO ROW IS WRITTEN. Before A2 this was a
        // silent first-write-wins: the door answered 200 with the ORIGINAL proposal's id
        // and the second payload was discarded while the caller was told it succeeded.
        // The IETF idempotency draft and Stripe both do this — "errors if they're not the
        // same to prevent accidental misuse". The response deliberately carries NO id, so
        // a caller cannot mistake it for a recorded proposal.
        if (row.payload_hash !== canonicalHash) {
          res.status(422).json({
            error: "idempotency key reused with a DIFFERENT payload",
            detail:
              "this key already names a proposal whose payload differs from the one just " +
              "sent. Nothing was recorded. A key identifies ONE logical attempt to ask; a " +
              "different ask is a different key.",
            idempotency_key: proposal.idempotency_key,
          });
          return;
        }

        // SAME KEY, SAME PAYLOAD, BUT THE EXISTING ROW IS DEAD. The unique index
        // `proposals_idempotency_unique` is permanent and STATE-BLIND, and A2 adds expiry
        // — so without this branch the sequence "broker away, row expires at the TTL,
        // agent re-proposes the identical ask" answers `200 {duplicate:true}` pointing at
        // a terminal row. Nothing would be queued, no card rendered, and every future
        // attempt under that key would hit the same corpse. The caller must be able to
        // tell a queued ask from a dead one, so a terminal row gets its own status.
        if (TERMINAL_PROPOSAL_STATES.has(row.state)) {
          res.status(409).json({
            error: "idempotency key already reached a TERMINAL state",
            detail:
              "this ask was already disposed of and nothing is queued. A deliberate " +
              "re-ask after a terminal outcome is a NEW key.",
            id: row.id,
            state: row.state,
            duplicate: true,
            terminal: true,
          });
          return;
        }

        res.status(200).json({
          id: row.id,
          state: row.state,
          duplicate: true,
        });
      } catch (err) {
        // NEVER SWALLOWED. The governing precedent is the plan's own AnthropicLlm.complete
        // finding: an error absorbed into a plausible-looking result is silently dangerous
        // in an action path, where a failure must stop rather than produce something that
        // reads like success. The response carries no `id`, so the caller cannot mistake it.
        console.error("[approval] failed to record proposal:", err);
        res.status(503).json({
          error: "proposal was NOT recorded",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  return app;
}
