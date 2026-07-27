import express from "express";
import type pg from "pg";
import { jsonbUnstorableReason, quarantineEvent } from "./quarantine.js";
import { ingestEvent } from "./ingest-event.js";
import { secretForSource, verifySignature } from "./hmac.js";
import { isSource, type Source } from "./sources.js";
import { eventSchema, type SourceEvent } from "./event-schema.js";
// Compatibility re-export: backfill.ts, ingest-event.ts, the connectors and several tests
// import the schema and its type from this module. The definition lives in event-schema.ts.
export { eventSchema };
export type { SourceEvent };

export function createIngestApp(
  pool: pg.Pool,
  opts?: { enqueue?: (source: Source, event: SourceEvent) => Promise<void> }
): express.Express {
  const app = express();
  // A5: reject non-JSON media types explicitly (415) BEFORE the parser — otherwise
  // express.json() skips the body, req.body is undefined, and the handler dies with a
  // 500 a vendor reads as "server fault, retry me".
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.method === "POST" && !req.is("application/json")) {
      return res.status(415).json({ error: "unsupported media type: send application/json" });
    }
    next();
  });
  // Capture the raw request body (before JSON parsing mutates it into an object) so we can
  // verify the HMAC signature against the exact bytes the source signed. The 100kb limit is
  // express's default made explicit — the error mapping below depends on it firing.
  app.use(
    express.json({
      limit: "100kb",
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: string }).rawBody = buf.toString("utf8");
      },
    }),
  );
  // Parser error middleware: malformed JSON → 400; oversized body → 413 (A5: RFC 9110
  // attributes both to the CLIENT — a 500 here would tell a well-behaved vendor to
  // retry a request that can never succeed, burning its retry budget).
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof SyntaxError && "body" in err) {
      return res.status(400).json({ error: "invalid json" });
    }
    if ((err as { status?: number }).status === 413) {
      return res.status(413).json({ error: "payload too large" });
    }
    next(err);
  });
  // Instance identity, NOT a health check. An open socket proves a process is listening;
  // it does not prove the process is the one the caller just started. That distinction has
  // already cost this repo one red CI run (a leftover mock inherited across steps — see
  // KNOWN-ISSUES "Process honesty"), and on THIS port it is worse than cosmetic: a stranded
  // ingest keeps polling its own feed on its own env, so `CHAOS_SKIP_BACKFILL=1` — whose
  // only job is to prove reconcile DETECTS loss — could reconcile clean and report PASS
  // while proving nothing. The scripts mint an id per run and refuse to proceed unless it
  // comes back. Deliberately answers from process state alone (no query): a probe used to
  // decide whose process this is must not fail for an unrelated reason. Unauthenticated, so
  // it carries the id and the service name and nothing else — no version, no config, no
  // connection details.
  app.get("/status", (_req, res) => {
    res.json({ service: "ingest", instance_id: process.env.INGEST_INSTANCE_ID ?? null });
  });
  app.post("/webhooks/:source", async (req, res, next) => {
    // Push-path authenticity check: this endpoint receives unsolicited data from the mock
    // sources, so we must verify each request was actually sent by a holder of THAT source's
    // secret (per-source secrets, D3) before trusting it at all. Unauthenticated data is
    // REJECTED (401), not quarantined — quarantine is for authenticated-but-malformed payloads
    // we want to preserve for later replay; an unsigned/forged request has no such provenance
    // to preserve.
    // (Contrast: the backfill poll path in backfill.ts pulls from a URL we already trust by
    // configuration — it has no equivalent forgery surface, so it is unaffected by this check.)
    try {
      // Unknown source = unknown path (404), checked BEFORE the signature — an unregistered
      // route is not an auth failure, and we must not pick a secret for a source we don't know.
      const sourceParam = req.params.source;
      if (!isSource(sourceParam)) {
        return res.status(404).json({ error: "unknown source" });
      }
      const source: Source = sourceParam;
      const rawBody = (req as express.Request & { rawBody?: string }).rawBody ?? "";
      const signature = req.header("x-switchboard-signature");
      if (!verifySignature(rawBody, signature, secretForSource(source))) {
        return res.status(401).json({ error: "invalid signature" });
      }
      // Unstorable divert: a U+0000 (the \u0000 escape) or a lone UTF-16 surrogate (the \ud800
      // escape) in any string is valid JSON and passes the signature check, but Postgres jsonb
      // cannot represent either (22P05 / 22P02) — so it is unstorable in raw.raw_events AND in
      // pg-boss's jsonb job table, and would 500 at insert/enqueue time, dropping an
      // authenticated payload. Nesting past the depth bound is the same class: JSON.stringify
      // (recursive in V8) and jsonb's own depth limit both reject it at insert/enqueue time.
      // Divert all of these to text-safe quarantine (preserved as raw_body) BEFORE schema
      // validation and enqueue, keeping "nothing delivered is ever dropped" true.
      // rawBody rides along on every quarantine call: for depth-diverted payloads it is the
      // ONLY safe source of raw_body text (re-stringifying the parsed object is the very call
      // that RangeErrors on deep nesting), and for the rest it preserves the wire bytes exactly.
      const unstorable = jsonbUnstorableReason(req.body);
      if (unstorable !== null) {
        await quarantineEvent(pool, source, req.body, unstorable, rawBody);
        return res.status(202).json({ quarantined: true });
      }
      const parsed = eventSchema.safeParse(req.body);
      if (!parsed.success) {
        await quarantineEvent(pool, source, req.body, "schema validation failed", rawBody);
        return res.status(202).json({ quarantined: true });
      }
      if (opts?.enqueue) {
        await opts.enqueue(source, parsed.data);
      } else {
        await ingestEvent(pool, source, parsed.data);
      }
      res.status(202).json({ stored: true });
    } catch (err) {
      next(err);
    }
  });
  // Terminal error handler: catch anything unhandled (e.g. a DB failure) and return a generic
  // 500 with no message/stack echo, so internal paths and error details never leak to clients.
  // Logged server-side (audit ops finding: a silent catch-all makes a 500 storm invisible
  // on BOTH sides of the wire).
  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(`[ingest] unhandled error on ${req.method} ${req.path}:`, err);
    res.status(500).json({ error: "internal error" });
  });
  return app;
}
