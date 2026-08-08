import express from "express";
import { z } from "zod";
import { appendToLedger, readLedger, type LedgerEntry, type LedgerEntryInput } from "./ledger.js";
import { createFaultInjector } from "./faults.js";
import { secretForSource, signBody } from "./hmac.js";

export type SourceEventSpec = { event_type: string; data: Record<string, unknown> };
export type EventScript = (index: number) => SourceEventSpec; // index = seq - 1 (0-based, monotonic per app)

export type SourceAppOptions = {
  source: string;
  webhookUrl: string;
  ledgerPath: string;
  script: EventScript;
  extraRoutes?: (app: express.Express) => void; // e.g. CRM's paginated GET /companies, /deals
};

export function createSourceApp(opts: SourceAppOptions): express.Express {
  const app = express();
  app.use(express.json());
  // JSON error middleware: catch malformed JSON and return clean 400
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof SyntaxError && "body" in err) {
      return res.status(400).json({ error: "invalid json" });
    }
    next(err);
  });
  let seq = 0;
  let serverLevelInjector = createFaultInjector(); // no plan → never faults

  // Freshness probe. `seq` is process-lifetime state: the script index that decides WHICH
  // event each slot emits is derived from it, so a caller that drives a mock inheriting a
  // non-zero cursor silently gets a different event mix than it asked for. An open socket
  // proves liveness, not readiness — callers must assert `fresh` before /simulate.
  app.get("/status", (_req, res) => {
    res.json({ source: opts.source, seq, fresh: seq === 0 });
  });

  app.get("/events", (req, res) => {
    if (serverLevelInjector.apiShouldFail()) {
      return res.status(429).json({ error: "rate limited" });
    }
    const after = Math.max(0, Number(req.query.after ?? 0) || 0);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50));
    const all = readLedger(opts.ledgerPath);
    const events = all.filter((e) => e.seq > after).slice(0, limit);
    const last_seq = events.length ? events[events.length - 1].seq : after;
    res.json({ events, last_seq });
  });

  app.post("/simulate", async (req, res) => {
    const schema = z.object({
      count: z.number().int().min(1).max(1000),
      // B3: explicit 0-based script index of the batch's FIRST event — emission becomes
      // a pure function of the request (identical requests emit identical events across
      // restarts). Absent → the process-lifetime counter, exactly as before.
      start_index: z.number().int().min(0).max(1_000_000_000).optional(),
      fault_plan: z.object({
        seed: z.number().int(),
        dropRate: z.number().min(0).max(1),
        dupRate: z.number().min(0).max(1),
        apiErrorRate: z.number().min(0).max(1),
        shuffleRate: z.number().min(0).max(1).optional(),
      }).optional(),
    });
    const parseResult = schema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: "invalid request" });
    }
    const { count, fault_plan, start_index } = parseResult.data;

    // B3: reposition the cursor for THIS batch when the request says where to start.
    // The finally below restores the counter's high-water mark (on every exit path,
    // including mid-batch 502s), so a low explicit index re-emits what it asked for
    // without rewinding later default batches — a shared ledger file keeps strictly
    // increasing seq for the chain verifier. Reuse of an index into the SAME ledger
    // file is the caller's choice and will (correctly) fail chain verification.
    const seqBefore = seq;
    if (start_index !== undefined) seq = start_index;
    try {
      // Create a fault injector for this simulate call
      const injector = createFaultInjector(fault_plan);
      // Update server-level injector for /events: set from plan if provided, else reset to no-fault
      serverLevelInjector = fault_plan ? createFaultInjector(fault_plan) : createFaultInjector();
      let emitted = 0;
      let dropped = 0;
      let duplicated = 0;
      // Events selected for shuffle are held back and delivered AFTER the rest of the batch,
      // so delivery order differs from emission order. Ledger order (seq) is unaffected.
      const deferred: { entry: LedgerEntry; deliveryCount: number }[] = [];
      const deliver = async (entry: LedgerEntry, deliveryCount: number): Promise<boolean> => {
        const body = JSON.stringify(entry);
        try {
          for (let d = 0; d < deliveryCount; d++) {
            const response = await fetch(opts.webhookUrl, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-switchboard-signature": signBody(body, secretForSource(opts.source)),
              },
              body,
            });
            if (!response.ok) return false;
          }
        } catch {
          return false;
        }
        return true;
      };
      for (let i = 0; i < count; i++) {
        const spec = opts.script(++seq - 1);
        const entryInput: LedgerEntryInput = {
          event_id: `evt-${seq}`,
          event_type: spec.event_type,
          occurred_at: new Date().toISOString(),
          data: spec.data,
          seq,
        };
        // Ledger append ALWAYS happens first, regardless of fate
        const entry: LedgerEntry = appendToLedger(opts.ledgerPath, entryInput);
        // Determine delivery fate
        const fate = injector.deliveryFate();
        if (fate === "drop") {
          // Drop: skip delivery entirely, no fetch, not counted in emitted
          dropped++;
          continue;
        }
        // Handle deliver and duplicate cases (both involve actual delivery)
        const deliveryCount = fate === "duplicate" ? 2 : 1;
        if (injector.shouldShuffle()) {
          // Out-of-order fault: hold this event back until the rest of the batch has gone out.
          deferred.push({ entry, deliveryCount });
          continue;
        }
        if (!(await deliver(entry, deliveryCount))) {
          return res.status(502).json({ error: "webhook delivery failed", emitted, dropped, duplicated });
        }
        // Count this event as emitted (whether delivered once or twice)
        emitted++;
        if (fate === "duplicate") {
          duplicated++;
        }
      }
      // Late delivery of shuffled events (arrival order != emission order).
      for (const { entry, deliveryCount } of deferred) {
        if (!(await deliver(entry, deliveryCount))) {
          return res.status(502).json({ error: "webhook delivery failed", emitted, dropped, duplicated });
        }
        emitted++;
        if (deliveryCount === 2) {
          duplicated++;
        }
      }
      res.json({ emitted, dropped, duplicated });
    } finally {
      if (seq < seqBefore) seq = seqBefore; // never rewind the process counter
    }
  });

  opts.extraRoutes?.(app);

  return app;
}
