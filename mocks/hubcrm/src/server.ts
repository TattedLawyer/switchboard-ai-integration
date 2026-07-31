// HTTP surface of the HubSpot-STYLE thin-webhook CRM (house conventions — see
// mocks/stripefeed/src/server.ts): the hydration API (single-object fetch-time reads
// with 429/5xx/poison injection, 404 after deletion), the full-store listing reconcile
// reads, /status freshness, and /simulate to drive the script + batched delivery.
//
// RED stub (Task C pair 2): surface only; implementation lands in the GREEN commit.

import type express from "express";
import type { HubStore } from "./store.js";

export interface HubcrmAppOptions {
  seed: number;
  /** Where /simulate delivers webhook batches (the ingest batch door). Optional: tests
   *  that drive the store in-process never need it. */
  webhookUrl?: string;
  portalId?: number;
  /** Seeded fraction of single-object reads answered 429. */
  read429?: { seed: number; rate: number };
  /** Seeded fraction of single-object reads answered 500. */
  read5xx?: { seed: number; rate: number };
  /** Object ids whose single-object read ALWAYS 500s — the persistent-poison fault. */
  poisonObjectIds?: number[];
}

export interface HubcrmApp {
  app: express.Express;
  store: HubStore;
}

export function createHubcrmApp(_opts: HubcrmAppOptions): HubcrmApp {
  throw new Error("not implemented (Task C pair 2 RED)");
}
