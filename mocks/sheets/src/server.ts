// HTTP API subset of the Sheets-shaped source. Express, house conventions (see
// mocks/core/source-app.ts + mocks/billing/src/server.ts) — but this source is a
// PULL-shaped snapshot API: no webhook push of full events, no ledger file. The grid
// itself is the reconciliation truth.

import { randomUUID } from "node:crypto";
import express from "express";
import { prng } from "@switchboard/mock-core";
import { createEditor, FAULT_PLANS, type Editor, type FaultPlanName } from "./editor.js";
import { createSheet, type SheetState } from "./sheet.js";
import { createTrigger, type SheetTrigger } from "./trigger.js";

export type Read429Options = {
  seed: number;
  /** Fraction of read requests (GET /values, GET /metadata) answered 429 — models the
   *  documented 300/min/project + 60/min/user read quotas. Backoff is the CONNECTOR's
   *  job (A4); the mock only injects the documented failure shape. */
  rate: number;
};

export type SheetsAppOptions = {
  seed: number;
  rowCount?: number;
  read429?: Read429Options;
  /** Optional push channel target. No URL → no trigger channel at all (a sheet with
   *  no Apps-Script trigger installed — the default posture). */
  webhookUrl?: string;
  trigger?: { seed?: number; dropRate?: number; delayMs?: number; dailyQuota?: number };
};

export type SheetsApp = {
  app: express.Express;
  /** Direct state access — the API/script-driven mutation path for tests. */
  sheet: SheetState;
  editor: Editor;
  /** Present iff webhookUrl was configured. */
  trigger?: SheetTrigger;
};

// Error body modeled on the documented Google API 429 shape (Sheets API limits page:
// "returns an HTTP 429 Too Many Requests status code"; body format per the standard
// Google API error envelope). Faithful enough for the connector's backoff logic to
// key off status + error.status.
const QUOTA_BODY = {
  error: {
    code: 429,
    message:
      "Quota exceeded for quota metric 'Read requests' and limit " +
      "'Read requests per minute per user' of service 'sheets.googleapis.com'.",
    status: "RESOURCE_EXHAUSTED",
  },
} as const;

export function createSheetsApp(opts: SheetsAppOptions): SheetsApp {
  const sheet = createSheet({ seed: opts.seed, rowCount: opts.rowCount });

  // The trigger is wired ONLY into the editor's human path. sheet.apply() — the
  // API/script write path — has no route to it (documented: "Script executions and
  // API requests don't cause triggers to run").
  const trigger = opts.webhookUrl
    ? createTrigger({
        sheetId: sheet.sheetId,
        webhookUrl: opts.webhookUrl,
        seed: opts.trigger?.seed ?? opts.seed,
        dropRate: opts.trigger?.dropRate,
        delayMs: opts.trigger?.delayMs,
        dailyQuota: opts.trigger?.dailyQuota,
      })
    : undefined;
  const editor = createEditor(sheet, { seed: opts.seed, onHumanEdit: trigger?.onHumanEdit });

  // Seeded read-fault stream: one draw per read request, in arrival order —
  // deterministic for any identical request sequence.
  const faultRand = opts.read429 ? prng(opts.read429.seed) : null;
  const readFaulted = () => faultRand !== null && faultRand() < (opts.read429?.rate ?? 0);

  const instance_id = randomUUID(); // minted per boot — the /status freshness identity

  const app = express();

  app.get("/values", (_req, res) => {
    if (readFaulted()) return res.status(429).json(QUOTA_BODY);
    res.json(sheet.values());
  });

  app.get("/metadata", (_req, res) => {
    if (readFaulted()) return res.status(429).json(QUOTA_BODY);
    res.json({ rows: sheet.metadata() });
  });

  // The combined atomic read (cold review I4): values + metadata from ONE consistent
  // grid state, in one response. Vendor-faithful — the real API's spreadsheets.get can
  // return grid data and developer metadata in a single call. The split /values +
  // /metadata pair stays for other consumers, but a connector DIFFING the grid must
  // read here: two reads of mutable state can pair rowKeys with the wrong rows when a
  // count-preserving edit lands between them. One draw from the same seeded fault
  // stream — this is one read request, whatever it bundles.
  app.get("/snapshot", (_req, res) => {
    if (readFaulted()) return res.status(429).json(QUOTA_BODY);
    res.json(sheet.snapshot());
  });

  // Process honesty (house convention): an open socket proves liveness, not readiness.
  // seq = applied human-step count; a non-zero seq means this instance has drifted from
  // its seeded state and scripts expecting a fresh boot must refuse it.
  app.get("/status", (_req, res) => {
    res.json({ service: "mock-sheets", instance_id, fresh: editor.steps() === 0, seq: editor.steps() });
  });

  // The human path over HTTP — mirrors the other mocks' /simulate, but query-driven:
  // POST /simulate?steps=N&plan=<calm|messy|bulk|hostile>. Only THIS path is human
  // editing; direct sheet.apply() calls model API/script writes.
  app.post("/simulate", async (req, res) => {
    const steps = Number(req.query.steps ?? 1);
    const plan = String(req.query.plan ?? "calm");
    if (!Number.isInteger(steps) || steps < 1 || steps > 1000) {
      return res.status(400).json({ error: "steps must be an integer 1..1000" });
    }
    if (!(FAULT_PLANS as readonly string[]).includes(plan)) {
      return res.status(400).json({ error: `unknown plan "${plan}" (${FAULT_PLANS.join("|")})` });
    }
    editor.applySteps(steps, plan as FaultPlanName);
    // Drain the push queue before answering so callers observe a settled channel.
    // Failed posts are already final by then — there is no retry to wait for.
    await trigger?.flush();
    res.json({ applied: steps, seq: editor.steps() });
  });

  return { app, sheet, editor, trigger };
}
