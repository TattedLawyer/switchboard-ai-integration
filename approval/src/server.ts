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

export interface ApprovalAppOptions {
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
        const pending = await pool.query(
          `select count(*)::int as n from approval.proposals
            where tenant_id = $1 and state = 'pending'`,
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

        // FLOOD CONTROL, half one. `on conflict do nothing` + a follow-up read makes a
        // replay a no-op at the DATABASE (the unique index) rather than at the door, so a
        // second poster racing the first cannot produce two rows. Returns the ORIGINAL
        // id, because an idempotent call must be indistinguishable from its first attempt
        // to a caller that retried after a timeout.
        const ins = await pool.query(
          `insert into approval.proposals
             (tenant_id, idempotency_key, action_type, payload, rationale)
           values ($1, $2, $3, $4::jsonb, $5)
           on conflict (tenant_id, idempotency_key) do nothing
           returning id, state`,
          [
            opts.tenantId,
            proposal.idempotency_key,
            proposal.action_type,
            JSON.stringify(proposal.payload),
            proposal.rationale,
          ],
        );
        if (ins.rowCount === 1) {
          res.status(201).json({ id: ins.rows[0].id, state: ins.rows[0].state });
          return;
        }
        const existing = await pool.query(
          `select id, state from approval.proposals
            where tenant_id = $1 and idempotency_key = $2`,
          [opts.tenantId, proposal.idempotency_key],
        );
        res.status(200).json({
          id: existing.rows[0].id,
          state: existing.rows[0].state,
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
