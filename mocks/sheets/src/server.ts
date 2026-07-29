// HTTP API subset of the Sheets-shaped source. Express, house conventions (see
// mocks/core/source-app.ts + mocks/billing/src/server.ts) — but this source is a
// PULL-shaped snapshot API: no webhook push of full events, no ledger file. The grid
// itself is the reconciliation truth.

import express from "express";
import type { Editor } from "./editor.js";
import type { SheetState } from "./sheet.js";

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
};

export type SheetsApp = {
  app: express.Express;
  /** Direct state access — the API/script-driven mutation path for tests. */
  sheet: SheetState;
  editor: Editor;
};

export function createSheetsApp(_opts: SheetsAppOptions): SheetsApp {
  throw new Error("not implemented (RED)");
}
