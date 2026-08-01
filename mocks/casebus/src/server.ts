// HTTP surface of the event-bus subscribe/replay source. House conventions (seeded
// determinism, /status process-honesty, /simulate) — but this paradigm is SUBSCRIBE-only:
// no webhook push, no ledger file, no HMAC door. The subscription IS the interface, and
// the retained window is the reconcile truth.
//
// ── The HTTP/JSON fidelity boundary (spec decision D12), stated plainly ────────────────
// The real Pub/Sub API is gRPC + Avro with a long-lived bidirectional Subscribe stream.
// This mock models the parts of the paradigm that matter to a connector — subscribe with
// a preset or a stored replay id, per-event opaque replay ids, resubscribe-from-cursor,
// at-least-once delivery, a 72h window, and a stream that can be reset — over HTTP/JSON.
// Deltas, each deliberate:
//   1. gRPC status codes become HTTP statuses. INVALID_ARGUMENT → 400. The error's own
//      `status` field carries the gRPC name so the CODE, not the number, is what a
//      connector keys on.
//   2. Avro payloads become JSON. Schema negotiation (GetSchema) is out of scope.
//   3. The gRPC TRAILER becomes the final NDJSON frame. This is not an invention: the
//      vendor's error guide instructs clients to read the StatusRuntimeException
//      *trailers* for the error code, so status-after-payload is the real protocol's own
//      shape. Rendering it as a trailing frame keeps that shape and — the reason it was
//      chosen over a wrapping JSON object — gives every event its OWN LINE, i.e. a
//      genuine per-event wire text. That is what lets the connector store honest
//      `raw_body` custody instead of a re-serialization (forbidden by the stripefeed
//      precedent).
//   4. One request serves one batch rather than holding a long-lived stream open. The
//      connector's drain loop supplies the "keep consuming" half.
//
// Error codes are VERBATIM from the vendor's error table (re-read 2026-07-31):
//   sfdc.platform.eventbus.grpc.subscription.fetch.replayid.corrupted        INVALID_ARGUMENT
//   sfdc.platform.eventbus.grpc.subscription.fetch.replayid.validation.failed INVALID_ARGUMENT
//   sfdc.platform.eventbus.grpc.subscription.fetch.requested.events.invalid   INVALID_ARGUMENT
// There is deliberately NO code for the reset case: the vendor documents the reset
// BEHAVIOR but publishes no distinguishing error code, so an age-out and a reset are
// byte-identical on the wire here too. The distinction is recoverable only structurally,
// from the stream identity — which is honest, because the documented root cause of a
// reset is the org moving to a new instance.

import { randomUUID } from "node:crypto";
import express from "express";
import { z } from "zod";
import { prng } from "@switchboard/mock-core";
import { CorruptedReplayIdError, REPLAY_PRESETS, createStream, type ReplayPreset, type StreamState } from "./stream.js";

export interface CasebusAppOptions {
  seed: number;
  /** Vertical profile (F-1) — threads to the stream's manifest; see StreamOptions. */
  profile?: import("@switchboard/mock-core").Profile;
  retentionHours?: number;
  /** See StreamOptions: these emission ordinals ship an unparseable `event_time`, so a
   *  poison event lands MID-BATCH between healthy ones — the standing poison-isolation
   *  rule's test material. */
  poisonEmissionIndexes?: number[];
  /** At-least-once delivery, as a seeded fault: this fraction of served events is
   *  re-served within the SAME batch. The connector's idempotency must absorb it, and
   *  the oracle must prove the absorption is COUNTED, not silently swallowed. */
  duplicate?: { seed: number; rate: number };
}

export interface CasebusApp {
  app: express.Express;
  /** Direct state access — the test/oracle path to the reconcile truth. */
  stream: StreamState;
  /** M4 fault knob (Task F): the next `n` successfully-served /subscribe responses
   *  render their trailing status frame WITHOUT `stream_id`. The field is the ONLY
   *  observable that distinguishes a reset from an age-out, and a real wire may simply
   *  not carry it — a connector that fills the hole with remembered identity is
   *  fabricating evidence. Error responses (corrupted cursor etc.) do not consume the
   *  budget: they never render a status frame. Overwrites any previous budget; 0 turns
   *  the knob off. */
  omitStreamIdInStatusFrames(n: number): void;
}

const busError = (
  res: express.Response,
  status: number,
  err: { status: string; code: string; message: string; field?: string },
) => res.status(status).type("application/json").send(JSON.stringify({ error: err }));

export function createCasebusApp(opts: CasebusAppOptions): CasebusApp {
  const stream = createStream({
    seed: opts.seed,
    profile: opts.profile,
    retentionHours: opts.retentionHours,
    poisonEmissionIndexes: opts.poisonEmissionIndexes,
  });
  const dupRand = opts.duplicate ? prng(opts.duplicate.seed) : null;
  const instance_id = randomUUID(); // minted per BOOT — the /status freshness identity,
  // deliberately distinct from stream_id, which moves on every reset.
  let omitStreamIdBudget = 0; // M4 knob — see CasebusApp.omitStreamIdInStatusFrames

  const app = express();
  app.use(express.json());

  app.get("/subscribe", (req, res) => {
    const presetRaw = req.query.replay_preset === undefined ? "LATEST" : String(req.query.replay_preset);
    if (!(REPLAY_PRESETS as readonly string[]).includes(presetRaw)) {
      return busError(res, 400, {
        status: "INVALID_ARGUMENT",
        code: "sfdc.platform.eventbus.grpc.subscription.fetch.replayid.validation.failed",
        message: `replay_preset must be one of ${REPLAY_PRESETS.join(", ")}`,
        field: "replay_preset",
      });
    }
    const preset = presetRaw as ReplayPreset;
    const replayId = req.query.replay_id === undefined ? null : String(req.query.replay_id);
    if (preset === "CUSTOM" && (replayId === null || replayId === "")) {
      // Verbatim documented case: "The replay_preset field in FetchRequest is set to
      // ReplayPreset.CUSTOM, but no Replay ID value is set".
      return busError(res, 400, {
        status: "INVALID_ARGUMENT",
        code: "sfdc.platform.eventbus.grpc.subscription.fetch.replayid.validation.failed",
        message: "The replay_preset field in FetchRequest is set to ReplayPreset.CUSTOM, but no Replay ID value is set",
        field: "replay_id",
      });
    }

    const numRequested = req.query.num_requested === undefined ? 100 : Number(req.query.num_requested);
    if (!Number.isInteger(numRequested) || numRequested <= 0) {
      return busError(res, 400, {
        status: "INVALID_ARGUMENT",
        code: "sfdc.platform.eventbus.grpc.subscription.fetch.requested.events.invalid",
        message: "The requested number of events in a fetch request must be greater than zero",
        field: "num_requested",
      });
    }

    let result;
    try {
      result = stream.fetch(preset, replayId, numRequested);
    } catch (err) {
      if (err instanceof CorruptedReplayIdError) {
        // ONE code for BOTH causes — age-out and reset are indistinguishable here, as
        // they are on the real wire. No cause hint is leaked: a connector that wants to
        // name the cause must derive it structurally.
        return busError(res, 400, {
          status: "INVALID_ARGUMENT",
          code: "sfdc.platform.eventbus.grpc.subscription.fetch.replayid.corrupted",
          message: err.message,
          field: "replay_id",
        });
      }
      throw err;
    }

    // NDJSON: one event per line (the genuine per-event wire text), then the trailer.
    const lines: string[] = [];
    for (const e of result.events) {
      lines.push(JSON.stringify(e));
      // At-least-once, as it actually happens: the SAME event delivered again. Byte-
      // identical, including the replay id — a redelivery is not a new event.
      if (dupRand !== null && dupRand() < (opts.duplicate?.rate ?? 0)) lines.push(JSON.stringify(e));
    }
    // M4 knob: an identity-omitting status frame — consumed only here, where a frame is
    // actually rendered (error paths above never reach this line).
    const omitStreamId = omitStreamIdBudget > 0;
    if (omitStreamId) omitStreamIdBudget--;
    lines.push(
      JSON.stringify({
        status: {
          code: "OK",
          ...(omitStreamId ? {} : { stream_id: stream.streamId() }),
          has_more: result.hasMore,
          latest_replay_id: result.latestReplayId,
        },
      }),
    );
    res.status(200).type("application/x-ndjson").send(lines.join("\n") + "\n");
  });

  // Process honesty (house convention): an open socket proves liveness, not readiness.
  // stream_id rides along because it is the ONLY observable that distinguishes a reset
  // from an age-out — an operator debugging a gap report needs it.
  app.get("/status", (_req, res) => {
    res.json({
      service: "mock-casebus",
      instance_id,
      fresh: stream.seq() === 0,
      seq: stream.seq(),
      stream_id: stream.streamId(),
    });
  });

  // The operator surface: advance the stream, the clock, or the world. Order is
  // deliberate — reset FIRST (it destroys history), then advance_s, then the emission —
  // so one call can reset, age what follows, and emit after it.
  app.post("/simulate", (req, res) => {
    const schema = z.object({
      count: z.number().int().min(1).max(1000).optional(),
      age_s: z.number().int().min(0).optional(),
      advance_s: z.number().int().min(0).optional(),
      reset: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (
      !parsed.success ||
      (parsed.data.count === undefined && parsed.data.advance_s === undefined && parsed.data.reset !== true)
    ) {
      return res.status(400).json({ error: "invalid request: need count (1..1000), advance_s, and/or reset" });
    }
    // age_s modifies an emission; without count there is nothing to age (the stripefeed
    // cold-review Minor 5 lesson: an operator flag that silently does nothing is a bug).
    if (parsed.data.age_s !== undefined && parsed.data.count === undefined) {
      return res.status(400).json({ error: "invalid request: age_s only applies to an emission — supply count" });
    }
    const { count, age_s, advance_s, reset } = parsed.data;
    if (reset === true) stream.reset();
    if (advance_s !== undefined) stream.advance(advance_s);
    let emitted = 0;
    if (count !== undefined) emitted = stream.emit(count, { ageS: age_s }).length;
    res.json({ emitted, seq: stream.seq(), now_s: stream.nowS(), stream_id: stream.streamId(), reset: reset === true });
  });

  return {
    app,
    stream,
    omitStreamIdInStatusFrames: (n: number) => {
      omitStreamIdBudget = n;
    },
  };
}
