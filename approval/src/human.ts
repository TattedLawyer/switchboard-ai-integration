// First Drive — the human decision surface. Two routes, deliberately ugly.
//
// 🚨 WHAT THIS IS NOT. It is not the broker's dashboard, it has no login, and it has no CSRF
// defence. It is the smallest thing that lets a person see a real proposal and decide it, so
// the loop can be observed end to end for the first time. Registration is OPT-IN
// (`operatorUserId` on the app options): absent, these routes do not exist, so every existing
// deployment and every existing test is byte-identical to before.
//
// 🚨 THE CONDITIONS UNDER WHICH IT IS ACCEPTABLE, stated so they cannot be assumed away:
//   1. A SCRATCH database. Every decision recorded here is append-only — no role holds UPDATE
//      or DELETE on `approval.decisions` — so a forged POST mints permanent, unfalsifiable
//      evidence that a named human decided something. That is tolerable on a disposable
//      database and nowhere else.
//   2. Loopback binding. `bindHost()` defaults to 127.0.0.1. Widening `APPROVAL_BIND_HOST`
//      puts THIS surface, which authenticates nobody, on the network alongside the door.
//   3. No real transport. With a stub sender an approval causes no outward action.
// Any one of those three changing is the trigger for real auth + CSRF. NOT the transport
// alone: the audit-fabrication hazard in (1) is independent of whether mail can leave.
//
// WHY `approveCard`/`rejectCard` AND NOT `decideOn`. Two separate reasons, both load-bearing:
//   · The 015 trigger requires the decision row and the state change in the SAME transaction.
//     `decideOn` deliberately opens none. Calling it on a bare pool client makes `dismissed`
//     autocommit its insert BEFORE the liveness check — a fabricated decision row that no
//     rollback removes.
//   · A decision must dispose of the byte-identical repeats behind its card, or they re-render
//     as a card the human already answered and approving that sends the same email twice.
import express from "express";
import type pg from "pg";
import { readPendingQueue } from "./queue.js";
import { collapseDuplicates, approveCard, rejectCard, type CollapsedCard } from "./suppress.js";
import { renderProposalCard, escapeHtml } from "./render.js";
import { decide, DecisionRefused } from "./decide.js";

export interface HumanRouteOptions {
  tenantId: string;
  /** A real `approval.users.id`. The FK is NOT NULL, so a literal placeholder fails 23503 on
   *  every fresh database — this is read from config and must name a seeded row. */
  operatorUserId: string;
}

function page(title: string, body: string): string {
  return (
    "<!doctype html><html><head><meta charset='utf-8'>" +
    `<title>${escapeHtml(title)}</title>` +
    // The rendered rationale is model-authored text. A restrictive CSP does not stop it
    // fooling a person — only the caption discipline in render.ts does that — but it caps
    // what any future escaping slip could reach.
    "<meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; style-src 'unsafe-inline'\">" +
    "<style>body{font-family:system-ui;margin:2rem;max-width:46rem}" +
    "article{border:1px solid #999;padding:1rem;margin:1rem 0}" +
    ".rationale-caption{font-size:.8rem;color:#666}" +
    "textarea{width:100%}</style></head><body>" +
    body +
    "</body></html>"
  );
}

export function registerHumanRoutes(
  app: express.Express,
  pool: pg.Pool,
  opts: HumanRouteOptions,
): void {
  const form = express.urlencoded({ extended: false });

  app.get("/queue", async (_req: express.Request, res: express.Response) => {
    try {
      const cards = collapseDuplicates(await readPendingQueue(pool, opts.tenantId));
      const body =
        cards.length === 0
          ? // NOT a cheerful blank. An empty queue and a broken queue look identical on a
            // page, and this project's worst defect class is a silence that reads as calm.
            "<h1>Nothing pending</h1><p>The queue read succeeded and returned no live " +
            `pending proposals for tenant <code>${escapeHtml(opts.tenantId)}</code>. ` +
            "That means one of: nothing was proposed, everything was already decided, or " +
            "everything expired unseen. This page cannot yet tell you which.</p>"
          : cards
              .map(
                (c) =>
                  "<form method='post' action='/decide'>" +
                  // The card carries the id only as a data- attribute, which forms do not
                  // submit. Without this hidden field every card is undecidable.
                  `<input type='hidden' name='proposalId' value='${escapeHtml(c.primary.id)}'>` +
                  renderProposalCard({
                    id: c.primary.id,
                    action_type: c.primary.action_type,
                    payload: c.primary.payload,
                    rationale: c.primary.rationale,
                    // 🚨 `QueueRow.expires_at` is DECLARED `string` (queue.ts:25) and is a
                    // `Date` at runtime — `pg` maps timestamptz to Date. Measured, not
                    // assumed: the first real render threw `value.replace is not a
                    // function` inside `escapeHtml`. Nothing caught it because every test
                    // builds `CardRow` by hand from string literals, so the read model and
                    // the renderer had never met real data. Coerced HERE rather than
                    // changing the shared read model, which other callers depend on; the
                    // declaration itself is still wrong and is logged as a defect.
                    expires_at: new Date(c.primary.expires_at).toISOString(),
                    duplicates: c.duplicates.length,
                  }) +
                  "<label>Reason (required to reject)<br>" +
                  "<textarea name='reason' rows='2'></textarea></label>" +
                  "</form>",
              )
              .join("");
      res.status(200).type("html").send(page("Approval queue", body));
    } catch (err) {
      // FAILS LOUD. Rendering an empty list here would convert a database outage into
      // "nothing to approve" — the exact silent-empty failure the page above warns about.
      console.error("[approval] queue read failed:", err);
      res
        .status(503)
        .type("html")
        .send(
          page(
            "Queue unavailable",
            "<h1>The queue could not be read</h1><p>This is NOT an empty queue. " +
              `<code>${escapeHtml(err instanceof Error ? err.message : String(err))}</code></p>`,
          ),
        );
    }
  });

  app.post("/decide", form, async (req: express.Request, res: express.Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const proposalId = typeof body.proposalId === "string" ? body.proposalId : "";
    const decision = typeof body.decision === "string" ? body.decision : "";
    const reason = typeof body.reason === "string" ? body.reason : "";

    const fail = (status: number, msg: string): void => {
      // NEVER a redirect. Redirecting on failure discards a human decision silently and
      // returns her to a queue that looks like she never clicked.
      res
        .status(status)
        .type("html")
        .send(page("Decision refused", `<h1>Not recorded</h1><p>${escapeHtml(msg)}</p>`));
    };

    try {
      // Re-read rather than trusting the posted id to still be live: between render and
      // click the row may have expired or been decided elsewhere. This also rebuilds the
      // duplicate grouping, so the decision disposes of the same repeats the card showed.
      const cards = collapseDuplicates(await readPendingQueue(pool, opts.tenantId));
      const card: CollapsedCard | undefined = cards.find((c) => c.primary.id === proposalId);
      if (!card) {
        fail(409, `Proposal ${proposalId} is no longer pending — it expired or was decided.`);
        return;
      }

      if (decision === "approved") {
        await approveCard(pool, card, opts.operatorUserId);
      } else if (decision === "rejected") {
        await rejectCard(pool, card, opts.operatorUserId, reason);
      } else if (decision === "dismissed") {
        // Leaves the proposal pending on purpose; only an explicit click reaches here.
        await decide(pool, {
          proposalId: card.primary.id,
          kind: "dismissed",
          approverUserId: opts.operatorUserId,
        });
      } else {
        fail(400, `Unknown decision "${decision}".`);
        return;
      }
      res.redirect(303, "/queue");
    } catch (err) {
      if (err instanceof DecisionRefused) {
        fail(400, err.message);
        return;
      }
      console.error("[approval] decision failed:", err);
      fail(503, err instanceof Error ? err.message : String(err));
    }
  });
}
