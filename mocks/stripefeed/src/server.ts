// HTTP surface of the Stripe-STYLE feed. House conventions (see mocks/sheets/src/server.ts)
// — but this paradigm is PULL-ONLY: no webhook push, no ledger file, no HMAC door. The
// /v1/events feed IS the interface, and the retained event set is the reconcile truth.
//
// Error bodies mirror the documented Stripe error envelope structurally
// (https://docs.stripe.com/api/errors): a top-level `error` object carrying `type`,
// `code`, `message`, `param`, `doc_url`. An unknown/aged-out `starting_after` answers
// 400 invalid_request_error / resource_missing naming the param — the shape Stripe
// serves for a cursor id it no longer knows (docs.stripe.com/error-codes, and the
// stripe-cli #923 report of the live response). Aged-out and never-existed cursors are
// indistinguishable on purpose: 30-day retention means the feed has genuinely forgotten.

import { randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";
import { prng } from "@switchboard/mock-core";
import { createFeed, UnknownCursorError, type FeedState } from "./feed.js";

export interface StripeFeedAppOptions {
  seed: number;
  retentionDays?: number;
  /** Response ordering is UNDOCUMENTED (research §2). Under this seeded flag every page
   *  is shuffled before serving, so a connector that trusts response position breaks in
   *  tests instead of production. One draw sequence per app — deterministic for any
   *  identical request sequence, the same convention as the sheets mock's read429. */
  shuffle?: { seed: number };
  /** Seeded read-fault stream: fraction of GET /v1/events answered 429 with the
   *  Stripe-shaped rate_limit_error. Backoff is the CONNECTOR's job. */
  read429?: { seed: number; rate: number };
}

export interface StripeFeedApp {
  app: express.Express;
  /** Direct state access — the test/oracle path to the reconcile truth. */
  feed: FeedState;
}

const stripeError = (
  res: express.Response,
  status: number,
  err: { type: string; code?: string; message: string; param?: string },
) =>
  res.status(status).json({
    error: {
      ...err,
      doc_url: err.code
        ? `https://docs.stripe.com/error-codes#${err.code.replace(/_/g, "-")}`
        : "https://docs.stripe.com/api/errors",
    },
  });

export function createStripeFeedApp(opts: StripeFeedAppOptions): StripeFeedApp {
  const feed = createFeed({ seed: opts.seed, retentionDays: opts.retentionDays });

  const shuffleRand = opts.shuffle ? prng(opts.shuffle.seed) : null;
  const faultRand = opts.read429 ? prng(opts.read429.seed) : null;
  const readFaulted = () => faultRand !== null && faultRand() < (opts.read429?.rate ?? 0);

  const instance_id = randomUUID(); // minted per boot — the /status freshness identity

  const app = express();
  app.use(express.json());

  app.get("/v1/events", (req, res) => {
    if (readFaulted()) {
      // Enum-drift disclosure (review Minor 1): the CURRENT api/errors reference
      // enumerates the error-object `type` as only api_error | card_error |
      // idempotency_error | invalid_request_error; `rate_limit_error` is the legacy
      // wire type — still what stripe-node maps to its documented StripeRateLimitError
      // class (error-handling guide). Kept because no current-docs pairing of a 429
      // with an enum member is documented, and inventing one would trade real-wire
      // fidelity for a fabricated shape. `code: "rate_limit"` IS currently documented
      // (error-codes: "Too many requests hit the API too quickly"). The connector keys
      // on HTTP 429 only and never reads these fields — pinned in its 429 tests.
      return stripeError(res, 429, {
        type: "rate_limit_error",
        code: "rate_limit",
        message: "Request rate limit exceeded. Retry the request with exponential backoff.",
      });
    }
    let limit = 10; // documented default
    if (req.query.limit !== undefined) {
      const raw = String(req.query.limit);
      limit = Number(raw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return stripeError(res, 400, {
          type: "invalid_request_error",
          message: `Invalid integer: ${raw}. limit must be between 1 and 100.`,
          param: "limit",
        });
      }
    }
    const startingAfter = req.query.starting_after === undefined ? null : String(req.query.starting_after);
    let page: { data: unknown[]; has_more: boolean };
    try {
      page = feed.page(startingAfter, limit);
    } catch (err) {
      if (err instanceof UnknownCursorError) {
        return stripeError(res, 400, {
          type: "invalid_request_error",
          code: "resource_missing",
          message: err.message,
          param: "starting_after",
        });
      }
      throw err;
    }
    // The undocumented-ordering fault, applied at the door: seeded Fisher–Yates within
    // the page. Membership and has_more are untouched — only position lies.
    if (shuffleRand !== null) {
      const data = [...page.data];
      for (let i = data.length - 1; i > 0; i--) {
        const j = Math.floor(shuffleRand() * (i + 1));
        [data[i], data[j]] = [data[j], data[i]];
      }
      page = { data, has_more: page.has_more };
    }
    res.json({ object: "list", url: "/v1/events", has_more: page.has_more, data: page.data });
  });

  // Process honesty (house convention): an open socket proves liveness, not readiness.
  app.get("/status", (_req, res) => {
    res.json({ service: "mock-stripefeed", instance_id, fresh: feed.seq() === 0, seq: feed.seq() });
  });

  // The operator surface: advance the stream and/or the mock clock. advance_s applies
  // FIRST so one call can age existing history and then emit fresh events after it.
  app.post("/simulate", (req, res) => {
    const schema = z.object({
      count: z.number().int().min(1).max(1000).optional(),
      age_s: z.number().int().min(0).optional(),
      advance_s: z.number().int().min(0).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success || (parsed.data.count === undefined && parsed.data.advance_s === undefined)) {
      return res.status(400).json({ error: "invalid request: need count (1..1000) and/or advance_s" });
    }
    // age_s modifies an emission; without count there is nothing to age — an operator
    // typo that silently did nothing before (cold review Minor 5). Refuse it loudly.
    if (parsed.data.age_s !== undefined && parsed.data.count === undefined) {
      return res.status(400).json({ error: "invalid request: age_s only applies to an emission — supply count" });
    }
    const { count, age_s, advance_s } = parsed.data;
    if (advance_s !== undefined) feed.advance(advance_s);
    let emitted = 0;
    if (count !== undefined) emitted = feed.emit(count, { ageS: age_s }).length;
    res.json({ emitted, seq: feed.seq(), now_s: feed.nowS() });
  });

  return { app, feed };
}
