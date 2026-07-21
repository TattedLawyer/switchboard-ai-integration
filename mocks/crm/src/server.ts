import express from "express";
import { z } from "zod";
import { generateSeed } from "./seed.js";
import { appendToLedger, readLedger, type LedgerEntry } from "./ledger.js";
import { createFaultInjector, type FaultPlan } from "./faults.js";

export function createCrmApp(opts: { webhookUrl: string; ledgerPath: string; seed?: number }): express.Express {
  const { companies, deals } = generateSeed(opts.seed);
  const app = express();
  app.use(express.json());
  let seq = 0;
  let serverLevelInjector = createFaultInjector(); // no plan → never faults

  const paginate = <T>(items: T[], req: express.Request) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const per = Math.min(100, Math.max(1, Number(req.query.per_page ?? 10)));
    return { items: items.slice((page - 1) * per, page * per), page, total: items.length };
  };

  app.get("/companies", (req, res) => res.json(paginate(companies, req)));
  app.get("/deals", (req, res) => res.json(paginate(deals, req)));

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
      }).optional(),
    });
    const { count, fault_plan } = schema.parse(req.body);

    // Create a fault injector for this simulate call
    const injector = createFaultInjector(fault_plan);

    // Update server-level injector for /events if a plan is provided
    if (fault_plan) {
      serverLevelInjector = createFaultInjector(fault_plan);
    }

    let emitted = 0;
    let dropped = 0;
    let duplicated = 0;

    for (let i = 0; i < count; i++) {
      const useCompany = i % 2 === 0;
      const entityIdx = Math.floor(i / 2);
      const entry: LedgerEntry = {
        event_id: `evt-${++seq}`,
        event_type: useCompany ? "company.updated" : "deal.updated",
        occurred_at: new Date().toISOString(),
        data: useCompany ? companies[entityIdx % companies.length] : deals[entityIdx % deals.length],
        seq,
      };

      // Ledger append ALWAYS happens first, regardless of fate
      appendToLedger(opts.ledgerPath, entry);

      // Determine delivery fate
      const fate = injector.deliveryFate();

      if (fate === "drop") {
        // Drop: skip delivery entirely, no fetch, not counted in emitted
        dropped++;
        continue;
      }

      // Handle deliver and duplicate cases (both involve actual delivery)
      const deliveryCount = fate === "duplicate" ? 2 : 1;

      try {
        for (let d = 0; d < deliveryCount; d++) {
          const response = await fetch(opts.webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(entry),
          });
          if (!response.ok) {
            return res.status(502).json({ error: "webhook delivery failed", emitted, dropped, duplicated });
          }
        }
      } catch {
        return res.status(502).json({ error: "webhook delivery failed", emitted, dropped, duplicated });
      }

      // Count this event as emitted (whether delivered once or twice)
      emitted++;
      if (fate === "duplicate") {
        duplicated++;
      }
    }

    res.json({ emitted, dropped, duplicated });
  });

  return app;
}
