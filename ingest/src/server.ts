import express from "express";
import { z } from "zod";
import type pg from "pg";
import { quarantineEvent } from "./quarantine.js";
import { ingestEvent } from "./ingest-event.js";
import { verifySignature } from "./hmac.js";

const eventSchema = z.object({
  event_id: z.string().min(1),
  event_type: z.string().min(1),
  occurred_at: z.string(),
  data: z.record(z.unknown()),
});

export type SourceEvent = z.infer<typeof eventSchema>;

export function createIngestApp(
  pool: pg.Pool,
  opts?: { enqueue?: (event: SourceEvent) => Promise<void> }
): express.Express {
  const app = express();
  // Capture the raw request body (before JSON parsing mutates it into an object) so we can
  // verify the HMAC signature against the exact bytes the source signed.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: string }).rawBody = buf.toString("utf8");
      },
    }),
  );
  // JSON error middleware: catch malformed JSON and return a clean 400 (mirrors
  // mocks/crm/src/server.ts's pattern) instead of express's default HTML error page.
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof SyntaxError && "body" in err) {
      return res.status(400).json({ error: "invalid json" });
    }
    next(err);
  });
  app.post("/webhooks/crm", async (req, res, next) => {
    // Push-path authenticity check: this endpoint receives unsolicited data from the mock
    // source, so we must verify it was actually sent by a holder of the shared secret before
    // trusting it at all. Unauthenticated data is REJECTED (401), not quarantined — quarantine
    // is for authenticated-but-malformed payloads we want to preserve for later replay; an
    // unsigned/forged request has no such provenance to preserve.
    // (Contrast: the backfill poll path in backfill.ts pulls from a URL we already trust by
    // configuration — it has no equivalent forgery surface, so it is unaffected by this check.)
    try {
      const rawBody = (req as express.Request & { rawBody?: string }).rawBody ?? "";
      const signature = req.header("x-switchboard-signature");
      if (!verifySignature(rawBody, signature)) {
        return res.status(401).json({ error: "invalid signature" });
      }
      const parsed = eventSchema.safeParse(req.body);
      if (!parsed.success) {
        await quarantineEvent(pool, "crm", req.body, "schema validation failed");
        return res.status(202).json({ quarantined: true });
      }
      if (opts?.enqueue) {
        await opts.enqueue(parsed.data);
      } else {
        await ingestEvent(pool, "crm", parsed.data);
      }
      res.status(202).json({ stored: true });
    } catch (err) {
      next(err);
    }
  });
  // Terminal error handler: catch anything unhandled (e.g. a DB failure) and return a generic
  // 500 with no message/stack echo, so internal paths and error details never leak to clients.
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "internal error" });
  });
  return app;
}
