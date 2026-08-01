import express from "express";
import type pg from "pg";
import { jsonbUnstorableReason, quarantineEvent } from "./quarantine.js";
import { ingestEvent } from "./ingest-event.js";
import { secretForSource, verifySignature } from "./hmac.js";
import { isSource, type Source } from "./sources.js";
import { eventSchema, type SourceEvent } from "./event-schema.js";
import { handleHubcrmBatch } from "./connectors/hub-hydrate.js";
// Compatibility re-export: backfill.ts, ingest-event.ts, the connectors and several tests
// import the schema and its type from this module. The definition lives in event-schema.ts.
export { eventSchema };
export type { SourceEvent };

export function createIngestApp(
  pool: pg.Pool,
  // rawBody: the exact request text of the webhook delivery, threaded to the queue so the
  // worker can store it (2b-D4 expand). Always jsonb-storable by the time enqueue is
  // reached: unstorable payloads divert to quarantine BEFORE this callback fires.
  opts?: {
    enqueue?: (source: Source, event: SourceEvent, rawBody: string) => Promise<void>;
    /** A5: the sheets nudge runner hook. Wiring it means "this process hosts a sheets
     *  connector; an authenticated nudge may trigger its early catchUp". Processes that
     *  don't host one leave it unset and the nudge door answers 503 (see below).
     *  A7 (signature): the return is a union because two hosts exist — a directly-held
     *  connector reports its ingested count (`nudge()` → number, the test hosting), while
     *  the service wiring's shared interval runner reports nothing (void: a coalesced
     *  nudge skips, and this door never used the count anyway — it only awaits). */
    sheetsNudge?: () => Promise<number | void>;
  }
): express.Express {
  const app = express();
  // B8: body handling is ROUTE-scoped, attached per POST route below, so routing
  // decides before body syntax does — a request to an unknown `:source` 404s with the
  // parser never run (Express's registration-order contract; research §B8). The three
  // pieces keep their pinned semantics (415/400/413, 2a.3+A5) for routes that exist.
  //
  // A5: reject non-JSON media types explicitly (415) BEFORE the parser — otherwise
  // express.json() skips the body, req.body is undefined, and the handler dies with a
  // 500 a vendor reads as "server fault, retry me".
  const mediaTypeGate = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!req.is("application/json")) {
      return res.status(415).json({ error: "unsupported media type: send application/json" });
    }
    next();
  };
  // Capture the raw request body (before JSON parsing mutates it into an object) so we can
  // verify the HMAC signature against the exact bytes the source signed. The 100kb limit is
  // express's default made explicit — the error mapping below depends on it firing.
  const jsonParser = express.json({
    limit: "100kb",
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: string }).rawBody = buf.toString("utf8");
    },
  });
  // Parser error middleware: malformed JSON → 400; oversized body → 413 (A5: RFC 9110
  // attributes both to the CLIENT — a 500 here would tell a well-behaved vendor to
  // retry a request that can never succeed, burning its retry budget). Sits in each
  // route's stack directly after the parser (a 4-arity handler is error middleware
  // wherever it is registered).
  const parserErrors = (err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof SyntaxError && "body" in err) {
      return res.status(400).json({ error: "invalid json" });
    }
    if ((err as { status?: number }).status === 413) {
      return res.status(413).json({ error: "payload too large" });
    }
    next(err);
  };
  // B8: the webhook route's FIRST middleware — an unknown source is an absent resource
  // (404) and body syntax is moot, so this must run before the parser ever allocates
  // for the body. Moved out of the handler (where it sat below the app-level parser).
  const validateWebhookSource = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Unknown source = unknown path (404), checked BEFORE the signature — an unregistered
    // route is not an auth failure, and we must not pick a secret for a source we don't know.
    // (Standalone-middleware typing: params is string | string[]; a repeated param can
    // only arrive as an array, which is never a valid source — treat it as unknown.)
    const sourceParam = typeof req.params.source === "string" ? req.params.source : "";
    if (!isSource(sourceParam)) {
      return res.status(404).json({ error: "unknown source" });
    }
    // A5: sheets is registered (deployment surface: base URL, secret, port) but its raw
    // lane is CONNECTOR-BORN — every event_id is manufactured from row content, and
    // deriveState reads the lane back as the connector's own memory. A generic signed
    // event accepted here would mint a foreign id inside that lane and poison every
    // later diff. So the generic event door stays closed BY NAME and points at the one
    // push surface the paradigm actually has (the thin, dataless nudge).
    if (sourceParam === "sheets") {
      return res
        .status(404)
        .json({ error: "sheets has no event door; its push surface is POST /connectors/sheets/nudge" });
    }
    next();
  };
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
  app.post("/webhooks/:source", validateWebhookSource, mediaTypeGate, jsonParser, parserErrors, async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Push-path authenticity check: this endpoint receives unsolicited data from the mock
    // sources, so we must verify each request was actually sent by a holder of THAT source's
    // secret (per-source secrets, D3) before trusting it at all. Unauthenticated data is
    // REJECTED (401), not quarantined — quarantine is for authenticated-but-malformed payloads
    // we want to preserve for later replay; an unsigned/forged request has no such provenance
    // to preserve.
    // (Contrast: the backfill poll path in backfill.ts pulls from a URL we already trust by
    // configuration — it has no equivalent forgery surface, so it is unaffected by this check.)
    try {
      // B8: source validity was decided by validateWebhookSource before the parser ran;
      // by here the param is a known, non-sheets source.
      const source: Source = req.params.source as Source;
      const rawBody = (req as express.Request & { rawBody?: string }).rawBody ?? "";
      const signature = req.header("x-switchboard-signature");
      if (!verifySignature(rawBody, signature, secretForSource(source))) {
        return res.status(401).json({ error: "invalid signature" });
      }
      // Task C: hubcrm delivers BATCHES (≤100 metadata-only events per request — the
      // researched vendor contract), so after the door's shared machinery (media-type
      // gate, raw-body capture, HMAC over the whole request) has run, the verified
      // request is handed to the connector module's batch handler: it splits the batch
      // and runs each element through the SAME per-event pipeline as below (unstorable
      // divert → schema gate → quarantine or ingest). Vendor knowledge stays in
      // connectors/hub-hydrate.ts; batch-fatal is forbidden there by construction.
      if (source === "hubcrm") {
        const outcome = await handleHubcrmBatch(pool, req.body, rawBody);
        return res.status(outcome.status).json(outcome.body);
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
        // Quarantine reason names the failing field: an operator triaging the queue must not
        // have to re-parse the payload by hand to learn WHICH field kept it out. The prefix
        // stays stable ("schema validation failed") — tooling and tests match on it.
        const detail = parsed.error.issues[0];
        const reason = detail
          ? `schema validation failed: ${detail.path.join(".")} — ${detail.message}`
          : "schema validation failed";
        await quarantineEvent(pool, source, req.body, reason, rawBody);
        return res.status(202).json({ quarantined: true });
      }
      // 2b-D4 expand: this door HOLDS the wire bytes (rawBody, verified above against the
      // signature), so both paths carry them to the insert. Note the stored payload is
      // parsed.data (schema-shaped); raw_body is the request text itself — the two are
      // deliberately NOT derivable from each other.
      if (opts?.enqueue) {
        await opts.enqueue(source, parsed.data, rawBody);
      } else {
        await ingestEvent(pool, source, parsed.data, { rawBody });
      }
      res.status(202).json({ stored: true });
    } catch (err) {
      next(err);
    }
  });
  // A5: the sheets nudge door — the ONLY push surface the sheet paradigm has. The mock's
  // Apps-Script-shaped trigger posts a thin {sheet_id, range, occurred_at} notification
  // here; it carries no row values (the channel may never be trusted with data — see
  // mocks/sheets/src/trigger.ts's honesty ledger), so its only meaning is "read the sheet
  // soon". Same house HMAC scheme and verify path as the event doors (per-source secret,
  // D3) — never a new crypto copy.
  app.post("/connectors/sheets/nudge", mediaTypeGate, jsonParser, parserErrors, async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      // Cold review I3: resolve the secret FIRST, and treat "no secret resolvable" as
      // "this deployment never configured sheets" — the route is effectively absent, so
      // answer 404 (mirroring the unknown-source shape above). Before this, the
      // fail-closed throw inside secretForSource surfaced as a generic 500 plus a
      // server-side error log on EVERY anonymous POST to this path on a sheets-less
      // deploy — repeatable noise a prober can mint at will. The event doors never had
      // this shape because their secrets are boot-asserted exactly when their source is
      // enabled; this door is mounted unconditionally, so it must fail closed as
      // absence. 401 stays reserved for configured-but-badly-signed, below.
      let secret: string;
      try {
        secret = secretForSource("sheets");
      } catch {
        return res.status(404).json({ error: "not found" });
      }
      const rawBody = (req as express.Request & { rawBody?: string }).rawBody ?? "";
      const signature = req.header("x-switchboard-signature");
      if (!verifySignature(rawBody, signature, secret)) {
        // REJECTED, never quarantined — the deliberate contrast with the event doors:
        // there, an authenticated-but-malformed EVENT is preserved because the payload is
        // the asset (a vendor delivered it exactly once). A nudge preserves nothing — the
        // sheet's truth is re-readable at will — so a forged/unsigned one is pure noise.
        return res.status(401).json({ error: "invalid signature" });
      }
      const nudge = opts?.sheetsNudge;
      if (!nudge) {
        // Authenticated but unwired: this process hosts no sheets connector, so a 202
        // would claim an effect that cannot happen. 503 is the honest answer.
        return res.status(503).json({ error: "no sheets connector in this process" });
      }
      // v1 (disclosed): await the coalescing nudge() directly — the mock is in-process,
      // so "an early catchUp soon" is simply "now", and single-flight coalescing in the
      // connector absorbs bursts. No scheduler (out of scope per the phase plan). A
      // failed catchUp still answers 202: the trigger channel has no retry machinery
      // (documented — a failed post is counted and abandoned), so failure detail is
      // useless to it; reconcile-first cycles remain the correctness guarantee.
      try {
        await nudge();
      } catch (err) {
        console.error("[ingest] sheets nudge catchUp failed (reconcile will recover):", err);
      }
      res.status(202).json({ accepted: true });
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
