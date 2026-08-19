// The knowledge authoring surface — where the broker writes the general business
// knowledge (023's `kb.general_entries`) that the CRM daemon chunks, embeds and later
// retrieves to answer questions.
//
// SAME DOOR, SAME DEFENCES AS /queue AND /decide, by construction rather than by
// parallel implementation: these routes are registered FROM `registerHumanRoutes`
// (human.ts) with the very middleware instances the decision surface uses — sessionMw,
// the Fetch-Metadata guard, csrf-sync's synchronizer token, requireLogin — and sit
// BEFORE human.ts's CSRF error handler, so a stale token here earns the same "Not
// recorded" page. Nothing on this surface has authority the session does not grant.
//
// THE GRANT REALITY SHAPES EVERY QUERY HERE (migration 023 + 024). The pool is
// `switchboard_approval`:
//   · entries: SELECT, INSERT, and column-level UPDATE on
//     (title, body, kind, status, updated_at, retired_at) — so `created_by` is written
//     once, at insert, and no code path here could rewrite attribution even if it tried;
//   · chunks: NOTHING. Index state arrives through 024's owner-owned view
//     (`kb.entry_index_state`), which exposes derived per-entry state and no vector,
//     text or hash in any form;
//   · DELETE: nobody holds it, anywhere in `kb`. Retire is a status flip and the row
//     stays, because a retrieval answer she saw last week must remain explainable this
//     week (023's own doctrine).
//
// 🚨 THE UPDATE ROUTE BUMPS `updated_at = now()`, AND THAT IS A CONTRACT, NOT TIDINESS.
// The embed worker's candidate query (crm/src/kb/embed-pass.ts) queues an entry when
// `updated_at > max(embedded_at)` — its header calls this "a CONTRACT WITH THE AUTHORING
// SURFACE". This file is that authoring surface. An update that does not bump
// `updated_at` is an edit that is NEVER re-embedded: the old text answers forever while
// the page shows her correction. Pinned in test/knowledge.test.ts (P8).
//
// THE BADGE IS COMPUTED, NEVER GENERATED, and it has an honest third state. "live" and
// "indexing…" come from the 024 view (the same predicates the worker queues on, so the
// badge and the daemon cannot disagree about whether work is owed). And an entry that
// has been waiting LONGER than any healthy pass interval explains (KB_INDEX_STALL_MINUTES
// below) says so out loud — a spinner that spins forever is this project's worst defect
// class, a silence that reads as calm.
import type express from "express";
import type pg from "pg";
import { escapeHtml } from "./render.js";

/** The five kinds 023's CHECK constraint admits — the server would refuse others with a
 *  23514 anyway; validating here turns that into a form message instead of a 503. */
export const KB_KINDS = ["listing", "business_fact", "policy", "faq", "service"] as const;
export type KbKind = (typeof KB_KINDS)[number];

/** When "indexing…" stops being an honest thing to display. The embed daemon's reconcile
 *  loop runs every ~60s and a pass handles 20 entries (DEFAULT_KB_EMBED_LIMIT,
 *  crm/src/kb/embed-pass.ts), so a healthy deployment indexes a new entry within a few
 *  minutes even with a backlog. Fifteen minutes of nothing means the daemon is not
 *  running or is failing — a condition to NAME, not to spin over. JUDGMENT number: any
 *  value comfortably above a few pass intervals serves; there is no source to cite. */
export const KB_INDEX_STALL_MINUTES = 15;

/** The middleware and helpers of human.ts's decision surface, passed BY INSTANCE so this
 *  file cannot drift onto a parallel session store, a second CSRF secret, or its own
 *  page chrome. */
export interface HumanSurfaceKit {
  sessionMw: express.RequestHandler;
  fetchMetadataGuard: express.RequestHandler;
  form: express.RequestHandler;
  csrfSynchronisedProtection: express.RequestHandler;
  requireLogin: (mode: "page" | "action") => express.RequestHandler;
  csrfField: (req: express.Request) => string;
  page: (title: string, body: string) => string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FormValues {
  kind: string;
  title: string;
  body: string;
}

function readForm(req: express.Request): FormValues {
  const body = (req.body ?? {}) as Record<string, unknown>;
  return {
    kind: typeof body.kind === "string" ? body.kind : "",
    title: typeof body.title === "string" ? body.title : "",
    body: typeof body.body === "string" ? body.body : "",
  };
}

/** Server-side validation: the same rules 023's CHECK constraints enforce, phrased for a
 *  person. Returns null when the input is acceptable. */
export function validateEntry(v: FormValues): string | null {
  if (!(KB_KINDS as readonly string[]).includes(v.kind)) {
    return `"${v.kind}" is not a kind this knowledge base stores — pick one of: ${KB_KINDS.join(", ")}.`;
  }
  if (v.title.trim() === "") return "The title is blank. Nothing was saved.";
  if (v.body.trim() === "") return "The body is blank. Nothing was saved.";
  return null;
}

/** The three honest badge states, derived from the 024 view's `state` plus how long the
 *  entry has been waiting (minutes since her last save — `updated_at`, which the entries
 *  table already tells this role). Exported so the test pins the derivation directly. */
export function indexBadge(state: string, waitingMinutes: number): string {
  if (state === "indexed") return "<span class='index-state'>live</span>";
  if (waitingMinutes >= KB_INDEX_STALL_MINUTES) {
    return (
      "<span class='index-state'>" +
      `still not indexed after ${Math.floor(waitingMinutes)} min — the indexer should have ` +
      "picked this up by now; tell your operator if it persists</span>"
    );
  }
  return "<span class='index-state'>indexing…</span>";
}

/** One form body, shared by /knowledge/new and /knowledge/:id/edit so the two cannot
 *  drift: her values (possibly refused, always preserved) are escaped into the fields. */
function entryForm(
  csrf: string,
  action: string,
  values: FormValues,
  errorMessage: string | null,
): string {
  const options = KB_KINDS.map(
    (k) =>
      `<option value='${k}'${k === values.kind ? " selected" : ""}>${k.replace("_", " ")}</option>`,
  ).join("");
  return (
    (errorMessage === null ? "" : `<p class='form-error'>${escapeHtml(errorMessage)}</p>`) +
    `<form method='post' action='${escapeHtml(action)}'>` +
    csrf +
    `<p><label>Kind<br><select name='kind'>${options}</select></label></p>` +
    `<p><label>Title<br><input name='title' value='${escapeHtml(values.title)}' size='60'></label></p>` +
    `<p><label>Body<br><textarea name='body' rows='10'>${escapeHtml(values.body)}</textarea></label></p>` +
    "<button>Save</button></form>" +
    "<p><a href='/knowledge'>Back to knowledge</a></p>"
  );
}

interface ListRow {
  id: string;
  kind: string;
  title: string;
  updated_at: string;
  state: string;
  waiting_minutes: number;
}

export function registerKnowledgeRoutes(
  app: express.Express,
  pool: pg.Pool,
  opts: { tenantId: string },
  kit: HumanSurfaceKit,
): void {
  const {
    sessionMw,
    fetchMetadataGuard,
    form,
    csrfSynchronisedProtection,
    requireLogin,
    csrfField,
    page,
  } = kit;

  const notFound = (res: express.Response, id: string): void => {
    res
      .status(404)
      .type("html")
      .send(
        page(
          "No such entry",
          `<h1>No such entry</h1><p>No knowledge entry <code>${escapeHtml(id)}</code> exists ` +
            "for this tenant. It may never have existed, or the link is stale.</p>" +
            "<p><a href='/knowledge'>Back to knowledge</a></p>",
        ),
      );
  };

  const failLoud = (res: express.Response, err: unknown): void => {
    // FAILS LOUD, /queue's discipline: rendering an empty page over a database outage
    // would convert the outage into "no knowledge", the silent-empty failure class.
    res
      .status(503)
      .type("html")
      .send(
        page(
          "Knowledge unavailable",
          "<h1>The knowledge base could not be read or written</h1><p>This is NOT an empty " +
            `list and nothing was recorded. <code>${escapeHtml(
              err instanceof Error ? err.message : String(err),
            )}</code></p>`,
        ),
      );
  };

  // ── The list ─────────────────────────────────────────────────────────────────────────

  app.get(
    "/knowledge",
    sessionMw,
    requireLogin("page"),
    async (req: express.Request, res: express.Response) => {
      try {
        // The badge's inputs ride the same read as the list: `state` from 024's view,
        // waiting time from the entries table's own `updated_at` — both COMPUTED from
        // stored rows, nothing generated.
        const r = await pool.query<ListRow>(
          `select e.id, e.kind, e.title, e.updated_at::text as updated_at, s.state,
                  (extract(epoch from (now() - e.updated_at)) / 60)::float8 as waiting_minutes
             from kb.general_entries e
             join kb.entry_index_state s on s.entry_id = e.id
            where e.tenant_id = $1 and e.status = 'active'
            order by e.created_at desc, e.id`,
          [opts.tenantId],
        );
        const body =
          r.rows.length === 0
            ? // NOT a cheerful blank — the /queue empty state's discipline: an empty
              // list and a broken read must not look alike.
              "<h1>No knowledge entries</h1><p>The read succeeded and returned no active " +
              `entries for tenant <code>${escapeHtml(opts.tenantId)}</code>. Either nothing ` +
              "has been added yet, or everything was retired — this page cannot tell you " +
              "which.</p><p><a href='/knowledge/new'>Add the first entry</a></p>"
            : "<h1>Knowledge</h1><p><a href='/knowledge/new'>Add an entry</a></p>" +
              r.rows
                .map(
                  (row) =>
                    "<article>" +
                    `<h2>${escapeHtml(row.title)}</h2>` +
                    `<p>${escapeHtml(row.kind)} · updated ${escapeHtml(
                      new Date(row.updated_at).toISOString(),
                    )} · ${indexBadge(row.state, row.waiting_minutes)}</p>` +
                    `<p><a href='/knowledge/${escapeHtml(row.id)}/edit'>Edit</a></p>` +
                    `<form method='post' action='/knowledge/${escapeHtml(row.id)}/retire'>` +
                    csrfField(req) +
                    "<button>Retire</button></form>" +
                    "</article>",
                )
                .join("");
        res.status(200).type("html").send(page("Knowledge", body));
      } catch (err) {
        console.error("[approval] knowledge list read failed:", err);
        failLoud(res, err);
      }
    },
  );

  // ── Authoring ────────────────────────────────────────────────────────────────────────

  app.get(
    "/knowledge/new",
    sessionMw,
    requireLogin("page"),
    (req: express.Request, res: express.Response) => {
      res
        .status(200)
        .type("html")
        .send(
          page(
            "Add knowledge",
            "<h1>Add knowledge</h1>" +
              entryForm(
                csrfField(req),
                "/knowledge/create",
                { kind: "listing", title: "", body: "" },
                null,
              ),
          ),
        );
    },
  );

  app.post(
    "/knowledge/create",
    sessionMw,
    fetchMetadataGuard,
    form,
    csrfSynchronisedProtection,
    requireLogin("action"),
    async (req: express.Request, res: express.Response) => {
      const values = readForm(req);
      const problem = validateEntry(values);
      if (problem !== null) {
        // HER TYPED VALUES SURVIVE THE REFUSAL — re-rendered into the form, never
        // discarded by a redirect. Pinned (P5).
        res
          .status(400)
          .type("html")
          .send(
            page(
              "Add knowledge",
              "<h1>Add knowledge</h1>" +
                entryForm(csrfField(req), "/knowledge/create", values, problem),
            ),
          );
        return;
      }
      // From the SESSION, and only from the session — how /decide attributes a decision.
      // requireLogin("action") has already proven it names a live, non-disabled approver.
      // A `created_by` field in the form body is never read (P3), and the role's grant
      // could not honour a forged one anyway: `created_by` is not among the UPDATE
      // columns, and the FK refuses ids that name nobody.
      const createdBy = req.session.userId as string;
      try {
        await pool.query(
          `insert into kb.general_entries (tenant_id, kind, title, body, created_by)
           values ($1, $2, $3, $4, $5)`,
          [opts.tenantId, values.kind, values.title, values.body, createdBy],
        );
        res.redirect(303, "/knowledge");
      } catch (err) {
        console.error("[approval] knowledge create failed:", err);
        failLoud(res, err);
      }
    },
  );

  // ── Editing ──────────────────────────────────────────────────────────────────────────

  app.get(
    "/knowledge/:id/edit",
    sessionMw,
    requireLogin("page"),
    async (req: express.Request, res: express.Response) => {
      const id = req.params.id as string;
      if (!UUID_RE.test(id)) {
        notFound(res, id);
        return;
      }
      try {
        const r = await pool.query<FormValues & { status: string }>(
          `select kind, title, body, status from kb.general_entries
            where id = $1 and tenant_id = $2`,
          [id, opts.tenantId],
        );
        if (r.rows.length === 0 || r.rows[0].status !== "active") {
          notFound(res, id);
          return;
        }
        res
          .status(200)
          .type("html")
          .send(
            page(
              "Edit knowledge",
              "<h1>Edit knowledge</h1>" +
                entryForm(csrfField(req), `/knowledge/${id}/update`, r.rows[0], null),
            ),
          );
      } catch (err) {
        console.error("[approval] knowledge edit read failed:", err);
        failLoud(res, err);
      }
    },
  );

  app.post(
    "/knowledge/:id/update",
    sessionMw,
    fetchMetadataGuard,
    form,
    csrfSynchronisedProtection,
    requireLogin("action"),
    async (req: express.Request, res: express.Response) => {
      const id = req.params.id as string;
      if (!UUID_RE.test(id)) {
        notFound(res, id);
        return;
      }
      const values = readForm(req);
      const problem = validateEntry(values);
      if (problem !== null) {
        res
          .status(400)
          .type("html")
          .send(
            page(
              "Edit knowledge",
              "<h1>Edit knowledge</h1>" +
                entryForm(csrfField(req), `/knowledge/${id}/update`, values, problem),
            ),
          );
        return;
      }
      try {
        // 🚨 `updated_at = now()` IS THE RE-EMBEDDING CONTRACT — see this file's header.
        // Guarded on `status = 'active'` so an entry retired under her feet answers with
        // the honest 409 below, never a silent no-op.
        const r = await pool.query(
          `update kb.general_entries
              set kind = $3, title = $4, body = $5, updated_at = now()
            where id = $1 and tenant_id = $2 and status = 'active'`,
          [id, opts.tenantId, values.kind, values.title, values.body],
        );
        if (r.rowCount !== 1) {
          res
            .status(409)
            .type("html")
            .send(
              page(
                "Not recorded",
                "<h1>Not recorded</h1><p>This entry is no longer active — it was retired " +
                  "or never existed for this tenant. Your edit was NOT saved.</p>" +
                  "<p><a href='/knowledge'>Back to knowledge</a></p>",
              ),
            );
          return;
        }
        res.redirect(303, "/knowledge");
      } catch (err) {
        console.error("[approval] knowledge update failed:", err);
        failLoud(res, err);
      }
    },
  );

  // ── Retiring ─────────────────────────────────────────────────────────────────────────

  app.post(
    "/knowledge/:id/retire",
    sessionMw,
    fetchMetadataGuard,
    form,
    csrfSynchronisedProtection,
    requireLogin("action"),
    async (req: express.Request, res: express.Response) => {
      const id = req.params.id as string;
      if (!UUID_RE.test(id)) {
        notFound(res, id);
        return;
      }
      try {
        // NOT A DELETE — no DELETE grant exists anywhere in `kb`, by 023's design. The
        // row stays; retrieval ignores retired entries (the store filters on status)
        // and this list stops showing them. Pinned (P6): the row survives the retire.
        const r = await pool.query(
          `update kb.general_entries
              set status = 'retired', retired_at = now()
            where id = $1 and tenant_id = $2 and status = 'active'`,
          [id, opts.tenantId],
        );
        if (r.rowCount !== 1) {
          res
            .status(409)
            .type("html")
            .send(
              page(
                "Not recorded",
                "<h1>Not recorded</h1><p>This entry is not active — it was already retired " +
                  "or never existed for this tenant. Nothing changed.</p>" +
                  "<p><a href='/knowledge'>Back to knowledge</a></p>",
              ),
            );
          return;
        }
        res.redirect(303, "/knowledge");
      } catch (err) {
        console.error("[approval] knowledge retire failed:", err);
        failLoud(res, err);
      }
    },
  );
}
