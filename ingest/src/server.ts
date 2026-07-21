import express from "express";
import { z } from "zod";
import type pg from "pg";

const eventSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  occurred_at: z.string(),
  data: z.record(z.unknown()),
});

export function createIngestApp(pool: pg.Pool): express.Express {
  const app = express();
  app.use(express.json());
  app.post("/webhooks/crm", async (req, res) => {
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "invalid event" });
    await pool.query(
      "insert into raw.raw_crm_events (event_id, event_type, payload) values ($1, $2, $3)",
      [parsed.data.event_id, parsed.data.event_type, JSON.stringify(parsed.data)],
    );
    res.status(202).json({ stored: true });
  });
  return app;
}
