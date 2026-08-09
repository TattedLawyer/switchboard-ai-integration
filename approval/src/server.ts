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
import {
  IDEMPOTENCY_FINGERPRINT_FIELDS,
  idempotencyFingerprint,
  payloadHash,
} from "./canonical.js";
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

/** SAME KEY, DIFFERENT ASK — 422, and NO ROW IS WRITTEN.
 *
 *  The IETF idempotency-key draft §2.7: "If there is an attempt to reuse an idempotency key
 *  with a different request payload, the resource SHOULD reply with a HTTP 422 status code",
 *  and "Clients MUST correct the requests… before performing a retry operation". Stripe
 *  errors "to prevent accidental misuse"; AWS returns `IdempotentParameterMismatch`. No
 *  source opened sanctions answering 200 to a body the server knows differs.
 *
 *  The body NAMES the fingerprint fields, because an undeclared subset is the actual defect
 *  this replaced — a caller must be able to see which fields make two asks the same. */
function respondToMismatch(res: express.Response, key: string): void {
  res.status(422).json({
    error: "idempotency key reused with a DIFFERENT ask",
    detail:
      "this key already names a proposal whose fingerprint differs from the one just sent. " +
      "Nothing was recorded. A key identifies ONE logical attempt to ask; a different ask " +
      "is a different key. Correct the request and retry, or use a new key.",
    idempotency_key: key,
    fingerprint_fields: IDEMPOTENCY_FINGERPRINT_FIELDS,
  });
}

/** SAME KEY, SAME ASK. A live row is an idempotent 200; a TERMINAL row is a distinguishable
 *  409, because the unique index is permanent and state-blind and a caller must be able to
 *  tell a queued ask from a disposed one. */
function respondToDuplicate(
  res: express.Response,
  row: { id: string; state: string },
): void {
  if (TERMINAL_PROPOSAL_STATES.has(row.state)) {
    res.status(409).json({
      error: "idempotency key already reached a TERMINAL state",
      detail:
        "this ask was already disposed of and nothing is queued. A deliberate re-ask after " +
        "a terminal outcome is a NEW key.",
      id: row.id,
      state: row.state,
      duplicate: true,
      terminal: true,
    });
    return;
  }
  res.status(200).json({ id: row.id, state: row.state, duplicate: true });
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
        // A2/T4. The hash is computed here, over the CANONICAL serialisation, and it has
        // EXACTLY ONE JOB: telling a retry of the same call apart from a different
        // proposal reusing a key. It is not a TOCTOU control, not a display binding, and
        // it is not what makes the payload immutable — that is the column grant and the
        // trigger in migration 015.
        const canonicalHash = payloadHash(proposal.payload);

        // A2/I-3 — THE PUBLISHED FINGERPRINT. `(action_type, payload_hash, rationale)`,
        // the same triple `suppress.ts` uses as its suppression key. The door and the
        // suppressor disagreeing about what makes two asks "the same" is what let a changed
        // rationale be swallowed silently.
        const fingerprint = idempotencyFingerprint({
          action_type: proposal.action_type,
          payload_hash: canonicalHash,
          rationale: proposal.rationale,
        });

        // A2/I-4 — THE REPLAY SHORT-CIRCUIT, and it is deliberately NARROW.
        //
        // 🚨 THIS DEPARTS FROM THE ONLY PUBLISHED PRECEDENT AND THE COMMENT SAYS SO. Stripe
        // documents the OPPOSITE in terms: "a request that's rate limited with a 429 can
        // produce a different result with the same idempotency key because RATE LIMITERS
        // RUN BEFORE THE API'S IDEMPOTENCY LAYER." The IETF draft is silent on the
        // question. So resolving a replay ahead of the limiter is NOT established practice
        // and must never be described as such.
        //
        // Two differences make Stripe's ordering wrong HERE, and they are the whole
        // justification:
        //   · Stripe's 429 means "you are going too fast, back off" — the ask is not lost
        //     and the remedy is time. Ours was returned even when the ask was ALREADY
        //     RECORDED AND QUEUED, which is not what RFC 6585 §4 describes.
        //   · Stripe's client advice for 4xx — "always generate a new idempotency key" — is
        //     ACTIVELY HARMFUL here: a new key produces a second row and a second card for
        //     the same ask, the exact duplicate `suppress.ts` exists to prevent. We cannot
        //     follow Stripe's client remedy, so we must not copy its server ordering.
        //
        // The justification we DO have is this code's own stated intent, two blocks down:
        // the limit bounds the agent's PRODUCTION RATE, and a byte-identical replay
        // produces nothing (`on conflict do nothing` guarantees it). Counting it does not
        // serve the stated purpose.
        //
        // 🚨 BOUNDED WHERE BOUNDING IS POSSIBLE: the short-circuit requires an
        // ALREADY-EXISTING row under this key. A NEW key never short-circuits and always
        // meets the full limiter — that is the boundary that matters, because a new key is
        // the only thing that can create a row.
        //
        // A MISMATCHED FINGERPRINT IS ALSO EXEMPT FROM BOTH COUNTERS, DELIBERATELY, and an
        // earlier version of this comment said the opposite ("still counted, or an attacker
        // would get unlimited free 422-generating requests"). The code always did this; the
        // comment was wrong, and so was its reasoning. Corrected rather than "fixed", after
        // deciding the question on its merits:
        //
        //   · AN APPLICATION-LEVEL COUNTER CANNOT BOUND REQUEST VOLUME — ONLY ROW CREATION.
        //     Counting mismatches converts an unbounded stream of 422s into an unbounded
        //     stream of 429s. It removes nothing. The cheapest unbounded path is a wrong
        //     bearer token, which costs ZERO queries and is answered 401 before this code
        //     is reached. "Unlimited free 4xx" is a property of every HTTP surface, not a
        //     property this branch introduces.
        //   · IT WOULD MAKE THE REAL RESIDUAL WORSE. A refused request currently costs ONE
        //     indexed lookup. Routing mismatches through the counters makes it THREE
        //     (this lookup, the cap count, the rate count). The genuine defect here is
        //     "a refused request costs a query", it is already disclosed in KNOWN-ISSUES,
        //     and its fix shape is a token bucket in FRONT of all of this — the only thing
        //     that actually bounds request volume.
        //   · IT WOULD PUNISH THE WRONG PARTY. The rate limit's stated purpose, two blocks
        //     down, is to bound the agent's PRODUCTION RATE. A mismatch writes nothing —
        //     exactly like a replay. Counting a client-side error against the budget that
        //     protects a human's queue means a client bug can 429 the operator's genuine
        //     new asks. The IETF draft's model is that a mismatch is a client error to be
        //     CORRECTED ("Clients MUST correct the requests… before performing a retry"),
        //     not a production event to be metered.
        //   · EXEMPTING REPLAYS BUT NOT MISMATCHES WOULD BE INCOHERENT. Both write nothing.
        //     The argument for one is the argument for the other.
        //
        // 🚨 LABEL: JUDGMENT. The research settles the REPLAY question and explicitly does
        // not reach this one — Stripe documents limiter-before-idempotency generally, and
        // the IETF draft contains no mention of rate limits, throttling or quota anywhere.
        // Neither addresses a fingerprint mismatch. This is our call, and KNOWN-ISSUES says
        // so along with the residual it leaves standing.
        const replay = await pool.query(
          `select id, state, payload_hash, action_type, rationale
             from approval.proposals
            where tenant_id = $1 and idempotency_key = $2`,
          [opts.tenantId, proposal.idempotency_key],
        );
        if (replay.rowCount === 1) {
          const existing = replay.rows[0] as {
            id: string;
            state: string;
            payload_hash: string;
            action_type: string;
            rationale: string;
          };
          if (idempotencyFingerprint(existing) === fingerprint) {
            respondToDuplicate(res, existing);
            return;
          }
          respondToMismatch(res, proposal.idempotency_key);
          return;
        }

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

        // We only reach here when the pre-check found nothing and the INSERT still hit the
        // unique index — i.e. a genuine concurrent poster won the race. Re-read and answer
        // through the same two helpers, so the racing path and the replay path cannot
        // drift apart.
        const existing = await pool.query(
          `select id, state, payload_hash, action_type, rationale from approval.proposals
            where tenant_id = $1 and idempotency_key = $2`,
          [opts.tenantId, proposal.idempotency_key],
        );
        const row = existing.rows[0] as {
          id: string;
          state: string;
          payload_hash: string;
          action_type: string;
          rationale: string;
        };

        if (idempotencyFingerprint(row) !== fingerprint) {
          respondToMismatch(res, proposal.idempotency_key);
          return;
        }
        respondToDuplicate(res, row);
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
