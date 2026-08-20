// 🚨 THE THROWAWAY TESTBOARD. This file is DELIBERATELY DISPOSABLE and must NEVER ship
// to a client deployment.
//
// WHAT IT IS. A plain, unstyled operator page (`/testboard`) where a human presses a
// button that runs a REAL pass — the proposer cycle, sheet adoption, the kb embed pass,
// the close/reconcile pass, an approval through the real spine — and then sees OBSERVED
// STATE READ BACK FROM THE DATABASE, not what the code thinks happened. Logs on this
// project have lied before (commit 41facc1: three emails recorded 'sent' while the relay
// had refused them; the bounce reconciler exists because of it), so every action here is
// do the thing → re-read the resulting rows → render what is actually there, unhappy
// fields included. A failure renders as loudly as a success; nothing here prints a
// silent "done".
//
// WHY IT REFUSES TO REGISTER BY DEFAULT — the non-shippability is STRUCTURAL. The
// observed-state reads span `crm.*`, `approval.*` and `kb.*`, which no service role may
// see together (that isolation is what A1/A2 rest on), so they run as the MIGRATION
// OWNER via DATABASE_URL — the operator-CLI precedent `crm/src/db.ts` documents
// (human-invoked, interactive, not a service). A surface holding the owner credential
// must not be reachable on a client box by accident, therefore `registerTestboardRoutes`
// RETURNS WITHOUT REGISTERING ANYTHING unless SWITCHBOARD_TESTBOARD=1 is set explicitly:
// a production deploy that never sets the flag has no /testboard route at all (pinned in
// testboard.test.ts T3).
//
// THE ROLE MAP, stated because it is the whole answer to "which pool":
//   · observed-state reads — OWNER (DATABASE_URL), the only principal that can see all
//     three schemas; read-only queries here, same posture as `crm-reconcile`'s listings.
//   · approve — the `switchboard_approval` pool the human surface already holds, through
//     the SAME `approveCard` spine `/decide` uses. Nothing new is granted.
//   · the passes — spawned as the SHIPPED OPERATOR CLIs in child processes, each under
//     its own documented credential (`crm-run-cycle`/`crm-kb-embed` as `switchboard_crm`
//     via CRM_DATABASE_URL; `crm-sheet adopt` and `crm-reconcile` as the owner). A child
//     process is used instead of importing crm sources because approval's tsconfig
//     (`rootDir: "."`) refuses cross-workspace imports (TS6059, measured) — and it is
//     MORE real, not less: the buttons run exactly what the operator would run.
//   · 🚨 NOTHING here touches `switchboard_agent`, and nothing grants it anything.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type express from "express";
import pg from "pg";
import { escapeHtml } from "./render.js";
import { readPendingQueue } from "./queue.js";
import { collapseDuplicates, approveCard } from "./suppress.js";
import { DecisionRefused } from "./decide.js";
import { canonicalStringify, payloadHash } from "./canonical.js";
import type { HumanSurfaceKit } from "./knowledge.js";

/** The enabling flag. Absent or anything other than "1" ⇒ no route exists. */
export const TESTBOARD_FLAG = "SWITCHBOARD_TESTBOARD";

/** Every state-changing route, in ONE place: registration iterates THIS list's handlers,
 *  and the T2 CSRF sweep iterates the same list — a POST route cannot exist here without
 *  being swept. */
export const TESTBOARD_POST_PATHS = [
  "/testboard/run-cycle",
  "/testboard/sheet-adopt",
  "/testboard/kb-embed",
  "/testboard/reconcile",
  "/testboard/approve",
] as const;

type PostPath = (typeof TESTBOARD_POST_PATHS)[number];

// ── Child-process plumbing ──────────────────────────────────────────────────────────────

/** Walk up from this module to the workspace root (the package.json named "switchboard"),
 *  so the path works from src (tsx/vitest) and from dist alike. */
function repoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const pj = path.join(dir, "package.json");
    if (existsSync(pj)) {
      try {
        if ((JSON.parse(readFileSync(pj, "utf8")) as { name?: string }).name === "switchboard") {
          return dir;
        }
      } catch {
        /* not the one; keep walking */
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('testboard: could not locate the repo root (package.json named "switchboard")');
}

interface CliResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

const OUTPUT_CAP = 100_000;

/** Run one shipped CLI under tsx, capture everything, never throw — a spawn failure is a
 *  result to RENDER, not an exception to lose. */
function runCli(
  scriptRelPath: string,
  args: string[],
  extraEnv: Record<string, string>,
  timeoutMs: number,
): Promise<CliResult> {
  return new Promise((resolve) => {
    let root: string;
    try {
      root = repoRoot();
    } catch (err) {
      resolve({
        command: scriptRelPath,
        exitCode: null,
        timedOut: false,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const tsx = path.join(root, "node_modules", ".bin", "tsx");
    const script = path.join(root, scriptRelPath);
    const command = `${tsx} ${script} ${args.join(" ")}`.trim();
    const child = spawn(tsx, [script, ...args], {
      cwd: root,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const take = (cur: string, chunk: Buffer): string =>
      cur.length >= OUTPUT_CAP ? cur : (cur + chunk.toString()).slice(0, OUTPUT_CAP);
    child.stdout.on("data", (c: Buffer) => (stdout = take(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = take(stderr, c)));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ command, exitCode: null, timedOut, stdout, stderr: `${stderr}\nspawn failed: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ command, exitCode: code, timedOut, stdout, stderr });
    });
  });
}

function renderCliResult(r: CliResult): string {
  const ok = r.exitCode === 0 && !r.timedOut;
  const verdict = r.timedOut
    ? `<p><strong>FAILED — timed out and was killed</strong> (exit ${String(r.exitCode)})</p>`
    : ok
      ? "<p><strong>exit 0 — the process reports success. Believe the read-back below, not this line.</strong></p>"
      : `<p><strong>FAILED — exit ${String(r.exitCode)}</strong></p>`;
  return (
    `<p><code>${escapeHtml(r.command)}</code></p>` +
    verdict +
    (r.stderr.trim() !== "" ? `<p>stderr:</p><pre>${escapeHtml(r.stderr)}</pre>` : "") +
    (r.stdout.trim() !== "" ? `<p>stdout:</p><pre>${escapeHtml(r.stdout)}</pre>` : "<p>(no stdout)</p>")
  );
}

// ── Registration ────────────────────────────────────────────────────────────────────────

export function registerTestboardRoutes(
  app: express.Express,
  pool: pg.Pool, // `switchboard_approval` — the SAME pool /decide approves through
  opts: { tenantId: string },
  kit: HumanSurfaceKit,
): void {
  // 🚨 THE STRUCTURAL NON-SHIP GUARD. Without the explicit flag, NOTHING below exists —
  // no route, no owner pool, nothing for a client deployment to expose by accident.
  if (process.env[TESTBOARD_FLAG] !== "1") return;

  const { sessionMw, fetchMetadataGuard, form, csrfSynchronisedProtection, requireLogin, csrfField, page } = kit;
  const tenantId = opts.tenantId;

  // The owner pool, created lazily on first read so a misconfigured DATABASE_URL is a
  // rendered error on the page, not a crash at boot. `allowExitOnIdle` so this throwaway
  // surface never pins a test process open.
  let ownerPool: pg.Pool | null = null;
  const owner = (): pg.Pool => {
    if (ownerPool === null) {
      const url = process.env.DATABASE_URL;
      if (url === undefined || url === "") {
        throw new Error(
          "DATABASE_URL is required: the testboard's observed-state reads run as the " +
            "migration owner (see this file's header).",
        );
      }
      ownerPool = new pg.Pool({ connectionString: url, max: 4, allowExitOnIdle: true });
      ownerPool.on("error", (err) => console.error("[testboard] owner pool error:", err));
    }
    return ownerPool;
  };

  const banner =
    "<p style='border:3px solid #c00;padding:.5rem'><strong>DISPOSABLE TEST SURFACE — not the " +
    "product.</strong> Buttons run the real passes; every table below is raw system state " +
    "RE-READ FROM THE DATABASE after the action, failures included. Enabled only by " +
    `<code>${TESTBOARD_FLAG}=1</code>. Never deploy this to a client.</p>` +
    "<p><a href='/testboard'>reload the board</a> · <a href='/queue'>the real queue</a></p>";

  // ── Observed-state sections. Each guards itself: one failing read must not blank the
  // page, and a read failure renders AS a failure, never as emptiness. ──────────────────

  const section = async (title: string, body: () => Promise<string>): Promise<string> => {
    try {
      return `<h2>${escapeHtml(title)}</h2>` + (await body());
    } catch (err) {
      return (
        `<h2>${escapeHtml(title)}</h2><p><strong>READ FAILED</strong> — this is NOT an empty ` +
        `section: <code>${escapeHtml(err instanceof Error ? err.message : String(err))}</code></p>`
      );
    }
  };

  const td = (v: unknown): string =>
    `<td>${v === null || v === undefined ? "<em>null</em>" : escapeHtml(String(v))}</td>`;

  const contactsSection = (): Promise<string> =>
    section("Contacts (crm.contacts, live)", async () => {
      const r = await owner().query(
        `select c.id, c.display_name, c.channel, c.next_due_at, c.active,
                c.linked_sheet_id, c.row_ref,
                (select string_agg(f.blocked_reason || ' (due ' || f.due_date || ')', '; ')
                   from crm.follow_ups f
                  where f.contact_id = c.id and f.closed_at is null
                    and f.blocked_reason is not null) as open_blocked_reasons
           from crm.contacts c
          where c.tenant_id = $1
          order by c.created_at desc
          limit 200`,
        [tenantId],
      );
      if (r.rowCount === 0) {
        return "<p>No contacts exist for this tenant (the read succeeded and returned zero rows).</p>";
      }
      return (
        "<table border='1'><tr><th>id</th><th>name</th><th>channel</th><th>next_due_at</th>" +
        "<th>active</th><th>linked_sheet_id</th><th>row_ref</th><th>blocked reasons (open)</th></tr>" +
        r.rows
          .map(
            (c) =>
              "<tr>" +
              td(c.id) + td(c.display_name) + td(c.channel) +
              td(c.next_due_at === null ? null : new Date(c.next_due_at as string).toISOString()) +
              td(c.active) + td(c.linked_sheet_id) + td(c.row_ref) + td(c.open_blocked_reasons) +
              "</tr>",
          )
          .join("") +
        "</table>"
      );
    });

  const proposalsSection = (req: express.Request): Promise<string> =>
    section("Proposals (approval.proposals + approval.executions, live)", async () => {
      const r = await owner().query(
        `select p.id, p.action_type, p.state, p.created_at, p.expires_at
           from approval.proposals p
          where p.tenant_id = $1
          order by p.created_at desc, p.id
          limit 200`,
        [tenantId],
      );
      if (r.rowCount === 0) {
        return "<p>No proposals exist for this tenant (the read succeeded and returned zero rows).</p>";
      }
      const ex = await owner().query(
        `select e.proposal_id, e.id, e.kind, e.vendor_reference, e.error, e.at
           from approval.executions e
           join approval.proposals p on p.id = e.proposal_id
          where p.tenant_id = $1
          order by e.at, e.id`,
        [tenantId],
      );
      const byProposal = new Map<string, typeof ex.rows>();
      for (const row of ex.rows) {
        const list = byProposal.get(row.proposal_id as string) ?? [];
        list.push(row);
        byProposal.set(row.proposal_id as string, list);
      }
      return r.rows
        .map((p) => {
          const execs = byProposal.get(p.id as string) ?? [];
          const execHtml =
            execs.length === 0
              ? "<p>No approval.executions row exists for this proposal — nothing has claimed or performed it.</p>"
              : "<ul>" +
                execs
                  .map(
                    (e) =>
                      `<li>execution ${escapeHtml(String(e.id))} kind=${escapeHtml(String(e.kind))}` +
                      ` at=${escapeHtml(new Date(e.at as string).toISOString())}` +
                      (e.vendor_reference !== null ? ` vendor_ref=${escapeHtml(String(e.vendor_reference))}` : "") +
                      (e.error !== null ? ` <strong>error=${escapeHtml(String(e.error))}</strong>` : "") +
                      "</li>",
                  )
                  .join("") +
                "</ul>";
          const approveForm =
            p.state === "pending"
              ? `<form method='post' action='/testboard/approve'>${csrfField(req)}` +
                `<input type='hidden' name='proposalId' value='${escapeHtml(String(p.id))}'>` +
                "<button>Approve this proposal (real spine)</button></form>"
              : "";
          return (
            `<article><p>proposal <code>${escapeHtml(String(p.id))}</code> ` +
            `action_type=${escapeHtml(String(p.action_type))} ` +
            `state=<strong>${escapeHtml(String(p.state))}</strong> ` +
            `created_at=${escapeHtml(new Date(p.created_at as string).toISOString())} ` +
            `expires_at=${escapeHtml(new Date(p.expires_at as string).toISOString())} ` +
            `· <a href='/testboard/payload?id=${escapeHtml(String(p.id))}'>full payload</a></p>` +
            execHtml +
            approveForm +
            "</article>"
          );
        })
        .join("");
    });

  const touchesSection = (): Promise<string> =>
    section("Touches (crm.touches + recorded answers, live)", async () => {
      const r = await owner().query(
        `select t.id, t.channel, t.disposition, t.identity_unverified, t.occurred_at
           from crm.touches t
           join crm.contacts c on c.id = t.contact_id
          where c.tenant_id = $1
          order by t.occurred_at desc
          limit 200`,
        [tenantId],
      );
      if (r.rowCount === 0) {
        return "<p>No touches exist for this tenant (the read succeeded and returned zero rows).</p>";
      }
      const answers = await owner().query(
        `select a.touch_id, q.prompt_text, a.value
           from crm.answers a
           join crm.questions q on q.id = a.question_id
           join crm.touches t on t.id = a.touch_id
           join crm.contacts c on c.id = t.contact_id
          where c.tenant_id = $1
          order by a.at, a.id`,
        [tenantId],
      );
      const byTouch = new Map<string, typeof answers.rows>();
      for (const a of answers.rows) {
        const list = byTouch.get(a.touch_id as string) ?? [];
        list.push(a);
        byTouch.set(a.touch_id as string, list);
      }
      return r.rows
        .map((t) => {
          const list = byTouch.get(t.id as string) ?? [];
          const answersHtml =
            list.length === 0
              ? "<p>No answers recorded for this touch.</p>"
              : "<ul>" +
                list
                  .map(
                    (a) =>
                      `<li>${escapeHtml(String(a.prompt_text))} → ${escapeHtml(String(a.value))}</li>`,
                  )
                  .join("") +
                "</ul>";
          return (
            `<article><p>touch <code>${escapeHtml(String(t.id))}</code> ` +
            `channel=${escapeHtml(String(t.channel))} ` +
            `disposition=${t.disposition === null ? "<em>null</em>" : escapeHtml(String(t.disposition))} ` +
            `identity_unverified=${escapeHtml(String(t.identity_unverified))} ` +
            // crm.touches has `occurred_at` (there is no created_at column); rendered as-is.
            `occurred_at=${escapeHtml(new Date(t.occurred_at as string).toISOString())}</p>` +
            answersHtml +
            "</article>"
          );
        })
        .join("");
    });

  const knowledgeSection = (): Promise<string> =>
    section("Knowledge (kb.general_entries + kb.entry_index_state, live)", async () => {
      const r = await owner().query(
        `select e.id, e.kind, e.title, e.status, s.chunk_count, s.embedded_count,
                s.pending_count, s.state
           from kb.general_entries e
           join kb.entry_index_state s on s.entry_id = e.id
          where e.tenant_id = $1
          order by e.created_at desc
          limit 200`,
        [tenantId],
      );
      if (r.rowCount === 0) {
        return "<p>No knowledge entries exist for this tenant (the read succeeded and returned zero rows).</p>";
      }
      return (
        "<table border='1'><tr><th>id</th><th>kind</th><th>title</th><th>status</th>" +
        "<th>index state</th><th>chunks</th><th>embedded</th><th>pending</th></tr>" +
        r.rows
          .map(
            (e) =>
              "<tr>" + td(e.id) + td(e.kind) + td(e.title) + td(e.status) +
              td(e.state) + td(e.chunk_count) + td(e.embedded_count) + td(e.pending_count) +
              "</tr>",
          )
          .join("") +
        "</table>"
      );
    });

  const sheetSection = (): Promise<string> =>
    section("Sheet health (latest crm.sheet_reads row, live)", async () => {
      const r = await owner().query(
        `select ok, detail, at from crm.sheet_reads
          where tenant_id = $1 order by at desc limit 1`,
        [tenantId],
      );
      if (r.rowCount === 0) {
        return (
          "<p>No crm.sheet_reads row exists — no adoption pass has ever recorded a read " +
          "for this tenant (no linked sheet, or the pass has never run).</p>"
        );
      }
      const row = r.rows[0];
      return (
        `<p>ok=<strong>${escapeHtml(String(row.ok))}</strong> ` +
        `at=${escapeHtml(new Date(row.at as string).toISOString())}</p>` +
        `<p>detail: <code>${escapeHtml(String(row.detail ?? "null"))}</code></p>`
      );
    });

  const allSections = async (req: express.Request): Promise<string> =>
    (await contactsSection()) +
    (await proposalsSection(req)) +
    (await touchesSection()) +
    (await knowledgeSection()) +
    (await sheetSection());

  const actionButtons = (req: express.Request): string => {
    const btn = (path: PostPath, label: string): string =>
      `<form method='post' action='${path}' style='display:inline'>${csrfField(req)}` +
      `<button>${escapeHtml(label)}</button></form> `;
    return (
      "<h2>Actions (each runs the REAL pass, then re-reads the database)</h2><p>" +
      btn("/testboard/run-cycle", "Run a proposer cycle") +
      btn("/testboard/sheet-adopt", "Run sheet adoption") +
      btn("/testboard/kb-embed", "Run the kb embed pass") +
      btn("/testboard/reconcile", "Run the close/reconcile pass") +
      "</p>" +
      `<form method='post' action='/testboard/approve'>${csrfField(req)}` +
      "<label>Approve a specific proposal by id (real spine)<br>" +
      "<input name='proposalId' size='40'></label> <button>Approve</button></form>" +
      "<form method='get' action='/testboard/payload'>" +
      "<label>Show a proposal's full payload by id<br>" +
      "<input name='id' size='40'></label> <button>Show payload</button></form>"
    );
  };

  // ── GET /testboard — current observed state ──────────────────────────────────────────

  app.get("/testboard", sessionMw, requireLogin("page"), async (req, res) => {
    res
      .status(200)
      .type("html")
      .send(page("Testboard", banner + actionButtons(req) + (await allSections(req))));
  });

  // ── GET /testboard/payload — the exact bytes the human approved (or would approve) ───

  app.get("/testboard/payload", sessionMw, requireLogin("page"), async (req, res) => {
    const id = typeof req.query.id === "string" ? req.query.id : "";
    let body: string;
    let status = 200;
    try {
      const r = await owner().query(
        `select id, action_type, state, rationale, payload, payload_hash
           from approval.proposals where id = $1 and tenant_id = $2`,
        [id, tenantId],
      );
      if (r.rowCount !== 1) {
        status = 404;
        body = `<p><strong>PAYLOAD LOOKUP FAILED</strong> — no proposal <code>${escapeHtml(id)}</code> exists for this tenant.</p>`;
      } else {
        const p = r.rows[0];
        const payload = p.payload as Record<string, unknown>;
        const canonical = canonicalStringify(payload);
        const recomputed = payloadHash(payload);
        const stored = String(p.payload_hash);
        body =
          `<h2>Proposal ${escapeHtml(String(p.id))}</h2>` +
          `<p>action_type=${escapeHtml(String(p.action_type))} state=<strong>${escapeHtml(String(p.state))}</strong></p>` +
          `<p>rationale:</p><pre>${escapeHtml(String(p.rationale))}</pre>` +
          `<p>payload (stored jsonb, pretty-printed):</p><pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>` +
          `<p>canonical serialisation (the exact bytes payload_hash covers):</p><pre>${escapeHtml(canonical)}</pre>` +
          `<p>stored payload_hash: <code>${escapeHtml(stored)}</code><br>` +
          `recomputed now:&nbsp;&nbsp;&nbsp; <code>${escapeHtml(recomputed)}</code> — ` +
          (recomputed === stored
            ? "<strong>MATCH</strong></p>"
            : "<strong>MISMATCH — the stored hash does not cover the stored payload. Investigate before trusting this row.</strong></p>");
      }
    } catch (err) {
      status = 500;
      body = `<p><strong>PAYLOAD LOOKUP FAILED</strong>: <code>${escapeHtml(err instanceof Error ? err.message : String(err))}</code></p>`;
    }
    res.status(status).type("html").send(page("Testboard payload", banner + body));
  });

  // ── The actions ──────────────────────────────────────────────────────────────────────

  /** One page shape for every action: what ran, loudly; then the re-read sections. */
  const actionPage = async (
    req: express.Request,
    res: express.Response,
    status: number,
    title: string,
    resultHtml: string,
  ): Promise<void> => {
    res
      .status(status)
      .type("html")
      .send(
        page(
          "Testboard",
          banner + `<h2>${escapeHtml(title)}</h2>` + resultHtml + (await allSections(req)),
        ),
      );
  };

  type PostHandler = (req: express.Request, res: express.Response) => Promise<void>;

  const cliAction =
    (
      title: string,
      cli: () => { script: string; args: string[]; env: Record<string, string>; timeoutMs: number },
    ): PostHandler =>
    async (req, res) => {
      const spec = cli();
      const result = await runCli(spec.script, spec.args, spec.env, spec.timeoutMs);
      const failed = result.exitCode !== 0 || result.timedOut;
      await actionPage(req, res, failed ? 500 : 200, title, renderCliResult(result));
    };

  const handlers: Record<PostPath, PostHandler> = {
    // 1. The real proposer cycle — the shipped one-shot CLI, posting through THIS app's
    //    real A2 door over HTTP (APPROVAL_URL = the host the operator is browsing).
    "/testboard/run-cycle": (req, res) =>
      cliAction("RUN CYCLE — the real proposer, via the real A2 door", () => ({
        script: "crm/src/cli/crm-run-cycle.ts",
        args: ["--tenant", tenantId],
        env: { APPROVAL_URL: `${req.protocol}://${req.get("host") ?? ""}` },
        timeoutMs: 180_000,
      }))(req, res),

    // 2. The real adoption pass (owner role, as shipped). The read-back is the
    //    sheet-health section: the pass records EXACTLY one sheet_reads row per outcome,
    //    breaker halts and failures included.
    "/testboard/sheet-adopt": cliAction("SHEET ADOPTION — the real pass", () => ({
      script: "crm/src/cli/crm-sheet.ts",
      args: ["adopt", tenantId],
      env: {},
      timeoutMs: 180_000,
    })),

    // 3. The real kb embed pass (one-shot CLI added beside the daemon; `switchboard_crm`
    //    role — the pass's documented least privilege). Slow on first run: it loads the
    //    local ~560MB model.
    "/testboard/kb-embed": cliAction("KB EMBED PASS — the real pass (local model)", () => ({
      script: "crm/src/cli/crm-kb-embed.ts",
      args: [],
      env: {},
      timeoutMs: 600_000,
    })),

    // 4. The real close/reconcile pass (owner role, as shipped). Its stdout IS computed
    //    from the database by the CLI; the sections below re-read the same tables.
    "/testboard/reconcile": cliAction("CLOSE / RECONCILE — the real pass", () => ({
      script: "crm/src/cli/crm-reconcile.ts",
      args: [],
      env: {},
      timeoutMs: 180_000,
    })),

    // 5. Approve through the REAL spine — the same readPendingQueue → collapseDuplicates
    //    → approveCard path /decide takes, on the same approval-role pool — then render
    //    ONLY what a re-read of the database shows: the proposal's state, the decision
    //    row (its DB-generated id), and the execution rows that exist (or the honest
    //    absence of one).
    "/testboard/approve": async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const proposalId = typeof body.proposalId === "string" ? body.proposalId.trim() : "";
      const approverUserId = req.session.userId as string;
      try {
        const cards = collapseDuplicates(await readPendingQueue(pool, tenantId));
        const card = cards.find((c) => c.primary.id === proposalId);
        if (card === undefined) {
          await actionPage(
            req,
            res,
            409,
            "APPROVE FAILED",
            `<p><strong>Proposal <code>${escapeHtml(proposalId)}</code> is not among the live ` +
              "pending proposals for this tenant</strong> — it was decided, expired, was " +
              "superseded, or never existed. Nothing was recorded; the sections below are " +
              "the re-read state.</p>",
          );
          return;
        }
        await approveCard(pool, card, approverUserId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await actionPage(
          req,
          res,
          err instanceof DecisionRefused ? 409 : 500,
          "APPROVE FAILED",
          `<p><strong>The decision was refused or errored</strong>: <code>${escapeHtml(msg)}</code>. ` +
            "The sections below are the re-read state — trust them over this message.</p>",
        );
        return;
      }

      // The read-back — from the database, via the owner pool, AFTER the act.
      const p = await owner().query(
        `select state, action_type, expires_at from approval.proposals where id = $1`,
        [proposalId],
      );
      const d = await owner().query(
        `select id, kind, approver_user_id, decided_at
           from approval.decisions where proposal_id = $1 order by decided_at, id`,
        [proposalId],
      );
      const e = await owner().query(
        `select id, kind, vendor_reference, error, at
           from approval.executions where proposal_id = $1 order by at, id`,
        [proposalId],
      );
      const stateHtml =
        p.rowCount === 1
          ? `<p>proposal state (read back): <strong>${escapeHtml(String(p.rows[0].state))}</strong> ` +
            `action_type=${escapeHtml(String(p.rows[0].action_type))}</p>`
          : "<p><strong>READ-BACK ANOMALY: the proposal row is GONE.</strong></p>";
      const decisionsHtml =
        d.rowCount === 0
          ? "<p><strong>READ-BACK ANOMALY: no decision row exists although approveCard returned.</strong></p>"
          : "<ul>" +
            d.rows
              .map(
                (row) =>
                  `<li>decision ${escapeHtml(String(row.id))} kind=${escapeHtml(String(row.kind))} ` +
                  `approver=${escapeHtml(String(row.approver_user_id))} ` +
                  `decided_at=${escapeHtml(new Date(row.decided_at as string).toISOString())}</li>`,
              )
              .join("") +
            "</ul>";
      const execHtml =
        e.rowCount === 0
          ? "<p>No approval.executions row exists for this proposal — approval recorded, but " +
            "nothing has claimed or performed it yet (that is the executor's job, and it has " +
            "not run or has refused).</p>"
          : "<ul>" +
            e.rows
              .map(
                (row) =>
                  `<li>execution ${escapeHtml(String(row.id))} kind=${escapeHtml(String(row.kind))}` +
                  (row.error !== null ? ` <strong>error=${escapeHtml(String(row.error))}</strong>` : "") +
                  ` at=${escapeHtml(new Date(row.at as string).toISOString())}</li>`,
              )
              .join("") +
            "</ul>";
      await actionPage(
        req,
        res,
        200,
        "APPROVE — read-back from the database",
        stateHtml + decisionsHtml + execHtml,
      );
    },
  };

  // Registration iterates the SAME list T2 sweeps — a route cannot exist unswept.
  for (const p of TESTBOARD_POST_PATHS) {
    app.post(
      p,
      sessionMw,
      fetchMetadataGuard,
      form,
      csrfSynchronisedProtection,
      requireLogin("action"),
      handlers[p],
    );
  }
}
