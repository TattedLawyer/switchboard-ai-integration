// HTTP surface of the HubSpot-STYLE thin-webhook CRM (house conventions — see
// mocks/stripefeed/src/server.ts): the hydration API (single-object fetch-time reads
// with 429/5xx/poison injection, 404 after deletion), the full-store listing reconcile
// reads, /status freshness, and /simulate to drive the script + batched delivery.
//
// The hydration API serves the store's CURRENT state — never any notify-time value.
// That asymmetry (thin event at T1, fetch at T2, mutations in between) is the D7 race
// the connector's snapshot table exists to make explicit, so the mock does nothing to
// hide it. A deleted object answers 404: aged-out and never-existed are
// indistinguishable, and the connector's tombstone is the honest record of that.

import { randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";
import { prng } from "@switchboard/mock-core";
import { createHubStore, type HubObjectType, type HubStore } from "./store.js";

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

const OBJECT_TYPES: readonly HubObjectType[] = ["company", "contact", "deal"];
const isObjectType = (v: string): v is HubObjectType => (OBJECT_TYPES as readonly string[]).includes(v);

export function createHubcrmApp(opts: HubcrmAppOptions): HubcrmApp {
  const store = createHubStore({ seed: opts.seed, portalId: opts.portalId });
  const rand429 = opts.read429 ? prng(opts.read429.seed) : null;
  const rand5xx = opts.read5xx ? prng(opts.read5xx.seed) : null;
  const poison = new Set(opts.poisonObjectIds ?? []);
  const instance_id = randomUUID();

  const app = express();
  app.use(express.json());

  // ── hydration API: fetch-TIME state, one object per read ──────────────────────────────
  app.get("/objects/:type/:id", (req, res) => {
    const { type, id } = req.params;
    if (!isObjectType(type)) {
      return res.status(404).json({ status: "error", category: "OBJECT_NOT_FOUND", message: `unknown object type ${type}` });
    }
    const objectId = Number(id);
    // Fault order: poison first (a poisoned object is broken regardless of weather),
    // then the seeded transient faults. Backoff/tombstoning is the CONNECTOR's job.
    if (poison.has(objectId)) {
      return res.status(500).json({ status: "error", category: "INTERNAL_ERROR", message: "object read failed" });
    }
    if (rand429 !== null && rand429() < (opts.read429?.rate ?? 0)) {
      return res
        .status(429)
        .json({ status: "error", category: "RATE_LIMITS", message: "You have reached your ten_secondly_rolling limit." });
    }
    if (rand5xx !== null && rand5xx() < (opts.read5xx?.rate ?? 0)) {
      return res.status(500).json({ status: "error", category: "INTERNAL_ERROR", message: "internal error" });
    }
    const record = store.get(type, objectId);
    if (record === undefined) {
      // Deleted and never-existed are INDISTINGUISHABLE by design — the connector's
      // deleted-before-fetch tombstone is the honest downstream record.
      return res.status(404).json({ status: "error", category: "OBJECT_NOT_FOUND", message: `${type} ${id} not found` });
    }
    res.json({ objectId: record.objectId, objectType: record.objectType, archived: false, properties: record.properties });
  });

  // ── the reconcile truth: full current store per type ──────────────────────────────────
  app.get("/objects/:type", (req, res) => {
    const { type } = req.params;
    if (!isObjectType(type)) {
      return res.status(404).json({ status: "error", category: "OBJECT_NOT_FOUND", message: `unknown object type ${type}` });
    }
    res.json({ results: store.list(type).map((r) => ({ objectId: r.objectId, objectType: r.objectType, properties: r.properties })) });
  });

  // Process honesty (house convention): an open socket proves liveness, not readiness.
  app.get("/status", (_req, res) => {
    res.json({ service: "mock-hubcrm", instance_id, fresh: store.seq() === 0, seq: store.seq() });
  });

  // ── the operator surface: run script ops, deliver signed batches ──────────────────────
  app.post("/simulate", async (req, res) => {
    const schema = z.object({
      count: z.number().int().min(1).max(1000),
      batch_size: z.number().int().min(1).max(100).optional(),
      redeliver_attempts: z.number().int().min(0).max(10).optional(),
      fault_plan: z
        .object({
          seed: z.number().int(),
          dropRate: z.number().min(0).max(1).optional(),
          dupRate: z.number().min(0).max(1).optional(),
          holdoverRate: z.number().min(0).max(1).optional(),
          shuffleWithinBatch: z.boolean().optional(),
        })
        .optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid request" });
    }
    if (!opts.webhookUrl) {
      return res.status(400).json({ error: "no webhookUrl configured for this mock — /simulate cannot deliver" });
    }
    const events = store.simulate(parsed.data.count);
    const stats = await store.deliver({
      webhookUrl: opts.webhookUrl,
      batchSize: parsed.data.batch_size,
      redeliverAttempts: parsed.data.redeliver_attempts,
      faultPlan: parsed.data.fault_plan,
    });
    res.json({ emitted: events.length, ...stats, seq: store.seq() });
  });

  return { app, store };
}
