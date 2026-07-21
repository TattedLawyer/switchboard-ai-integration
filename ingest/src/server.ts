import express from "express";
import { z } from "zod";
import type pg from "pg";
import { quarantineEvent } from "./quarantine.js";
import { ingestEvent } from "./ingest-event.js";

const eventSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  occurred_at: z.string(),
  data: z.record(z.unknown()),
});

export type CrmEvent = z.infer<typeof eventSchema>;

export function createIngestApp(
  pool: pg.Pool,
  opts?: { enqueue?: (event: CrmEvent) => Promise<void> }
): express.Express {
  const app = express();
  app.use(express.json());
  app.post("/webhooks/crm", async (req, res) => {
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) {
      await quarantineEvent(pool, req.body, "schema validation failed");
      return res.status(202).json({ quarantined: true });
    }
    if (opts?.enqueue) {
      await opts.enqueue(parsed.data);
    } else {
      await ingestEvent(pool, parsed.data);
    }
    res.status(202).json({ stored: true });
  });
  return app;
}
