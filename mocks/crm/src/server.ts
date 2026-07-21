import express from "express";
import { z } from "zod";
import { generateSeed } from "./seed.js";
import { appendToLedger, type LedgerEntry } from "./ledger.js";

export function createCrmApp(opts: { webhookUrl: string; ledgerPath: string; seed?: number }): express.Express {
  const { companies, deals } = generateSeed(opts.seed);
  const app = express();
  app.use(express.json());
  let seq = 0;

  const paginate = <T>(items: T[], req: express.Request) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const per = Math.min(100, Math.max(1, Number(req.query.per_page ?? 10)));
    return { items: items.slice((page - 1) * per, page * per), page, total: items.length };
  };

  app.get("/companies", (req, res) => res.json(paginate(companies, req)));
  app.get("/deals", (req, res) => res.json(paginate(deals, req)));

  app.post("/simulate", async (req, res) => {
    const { count } = z.object({ count: z.number().int().min(1).max(1000) }).parse(req.body);
    let emitted = 0;
    for (let i = 0; i < count; i++) {
      const useCompany = i % 2 === 0;
      const entry: LedgerEntry = {
        event_id: `evt-${++seq}`,
        event_type: useCompany ? "company.updated" : "deal.updated",
        occurred_at: new Date().toISOString(),
        data: useCompany ? companies[seq % companies.length] : deals[seq % deals.length],
      };
      appendToLedger(opts.ledgerPath, entry);      // ledger FIRST — it is the oracle
      try {
        const response = await fetch(opts.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(entry),
        });
        if (!response.ok) {
          return res.status(502).json({ error: "webhook delivery failed", emitted });
        }
      } catch {
        return res.status(502).json({ error: "webhook delivery failed", emitted });
      }
      emitted++;
    }
    res.json({ emitted });
  });

  return app;
}
