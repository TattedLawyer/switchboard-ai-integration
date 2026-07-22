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
    const { count, fault_plan } = parseResult.data;

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
  });

  opts.extraRoutes?.(app);

  return app;
}
