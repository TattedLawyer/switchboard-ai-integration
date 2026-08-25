// directScriptedSpeech — the direct-socket implementation of `ScriptedVoiceSession.say`,
// returning the EXISTING `SpeechDelivery` contract (voice-agent-session.ts:97-100). The
// intake loop above it does not change; this channel replaces `realtimeScriptedSpeech`
// underneath it, and inherits every honesty rule that adapter earned on live calls:
//
//   · `voicedAt` is the FIRST-FRAME time, never the say-call clock. The say-call stamp
//     is the exact lie the 2026-08-22 leak call persisted ("Uh" filed as an answer, the
//     owner's complaint stored as a lead's must-haves) and e10a401 exists to prevent —
//     on the plugin path the stamp came from the library's committed assistant item; on
//     the raw socket WE are the library, so the stamp is the injected clock read at the
//     first audio event since arm (`onAudioFrame`), which the worker feeds the moment
//     model audio reaches the output path.
//   · Barge-in is REPORTED, never swallowed: no frames + caller evidence (an interrupt
//     OR any transcription fragment) is `{delivered:false, partial:false}` — a void
//     return here is what let the old loop open an answer window on a question nobody
//     heard. The evidence arrives LATE on a real call (23ms after the interrupt there
//     was no transcript yet — voice-agent-session.ts:677-691), hence BARGE_IN_GRACE_MS
//     rather than a synchronous check.
//   · Honest death, never a fabricated report: no frames and no evidence, a watchdog
//     expiry with no frames, or the socket-health latch all THROW out of say — the
//     transport's rule 2, honoured end to end.
//
// WHAT IS SIMPLER HERE THAN ON THE PLUGIN PATH — and why this migration exists: the raw
// socket's signals are DIRECT. `waitForPlayout` resolving proved nothing (the library
// stashes errors and resolves anyway — livekit/agents #6224, fix rejected upstream), so
// the realtime adapter needed an observer fed from a state event. Here the first audio
// frame IS the event, `turnComplete` IS the completion signal, and `interrupted` IS the
// cut-off signal — no inference, no observer seam, no #6224.
//
// THE SOCKET-HEALTH LATCH: a close with code ≠ 1000 (the 1007 family lives here) or an
// error event kills the channel PERMANENTLY — the pending say rejects, and every later
// say rejects before sending anything, because a directive written into a dead socket
// is a fabricated delivery. A CLEAN close (1000, the callee hung up) also rejects a
// pending say — nothing can arrive any more, and sitting on the watchdog pretending
// otherwise delays the teardown the hangup guard owes the line — and equally refuses
// later says: the socket is gone either way; only the error message differs.
import {
  BARGE_IN_GRACE_MS,
  MODEL_TURN_FINALIZE_MARGIN_MS,
  SPEAK_WATCHDOG_MS,
  speakTurnInstruction,
  type SpeechDelivery,
} from "./voice-agent-session.js";
import { directiveTurn, type DirectiveTurn } from "./voice-direct-events.js";

/** THE STALE-PAIR WINDOW (B1, 2026-08-24 — the fix for three live kills): Gemini pairs
 *  every `interrupted` with the ABORTED turn's trailing bare `turnComplete` ~1ms later.
 *  When the loop's re-ask directive departs in the same tick as the interrupt (live
 *  ab-25: interrupted +28859 → send-directive +28859 → bare turn-complete +28860; live
 *  w-p1: +97062 → +97063 → +97063 — both stale TCs LACKED the per-turn summary fields,
 *  because the tracker had already closed the turn inside `onInterrupted`), this
 *  channel used to read that trailing TC as "the fresh say completed with zero audio"
 *  and throw the honest death on a line that was fine. So: a NO-FRAMES `turnComplete`
 *  arriving strictly less than this many ms after OUR OWN send is the aborted turn's
 *  finalize, not ours — ignored, and LOGGED (see `onStaleTurnCompleteIgnored`).
 *
 *  Measured basis, stated because it is THIN (review finding F3): stale deltas 1ms
 *  (live, n=2) and 1–5ms (dry socket); the fastest GENUINE first audio ever measured
 *  arrived 743ms post-send, and every other genuine response was ≥743ms (767 / 812 /
 *  841 / 2888 / 3394ms). The nearest genuine ZERO-AUDIO observation is n=1 with
 *  unpreserved raw output — hence the window is env-tunable at the worker edge
 *  (VOICE_STALE_TC_WINDOW_MS → `staleTurnCompleteWindowMs`) and EVERY ignored TC is
 *  logged with its delta so live data validates or moves it.
 *
 *  ACCEPTED WORST CASE, stated plainly: a falsely-ignored GENUINE zero-audio TC does
 *  not kill the call and does not fabricate a delivery — the say simply keeps waiting
 *  under SPEAK_WATCHDOG_MS (30s) and then settles honestly through the watchdog path.
 *  But that is up to 30 seconds of dead air in the caller's ear before the channel
 *  admits the turn made no sound. */
export const STALE_TURN_COMPLETE_WINDOW_MS = 300;

/** What the channel reports for every turnComplete it ignores as the stale pair's
 *  trailing finalize — the F3 telemetry that turns the thin measured basis above into
 *  live validation data. The worker logs one line per ignore. */
export interface StaleTurnCompleteIgnored {
  /** Delta from OUR send to this turnComplete — stale pairs measured 1ms live. */
  msSinceSend: number;
  utterance: string;
  awaitingEvidence: boolean;
  callerEvidence: boolean;
}

/** What this channel needs from the worker's socket plumbing: the ability to put ONE
 *  DirectiveTurn on the wire. Structural on purpose (the containment rule) — the worker
 *  passes a closure over `session.sendClientContent`, tests pass an array-push. */
export interface DirectSpeechHost {
  sendDirective(turn: DirectiveTurn): void;
}

/** THE MODEL-TURN GATE (2026-08-23 diagnosis): a `sendClientContent` landing while the
 *  server's playout estimate is still running makes 3.1 emit `interrupted` 47–134ms
 *  later with NO caller audio involved (probe E7/E11, n=12) — the live call's 3/3
 *  interrupts were the loop's own next-question directives, and the worker then
 *  clearQueue()d ~60% of the model's in-flight reply as "caller barge-in". So a say
 *  may not SEND while a model turn is in flight: it PARKS, releases at the wire's
 *  `turnComplete`, and is bounded by this deadline (the tracker caps it absolutely —
 *  voice-model-turn.ts). Structural on purpose: the worker passes the tracker's
 *  `sendWaitDeadline`, tests pass a mutable stub. Undefined = nothing in flight. */
export interface ModelTurnGate {
  sendWaitDeadline(): number | undefined;
}

export interface DirectSpeechChannelOptions {
  /** The clock `voicedAt` is stamped from — INJECTED (the date-boundary lesson), read
   *  at the first-frame event, never at the say call. Defaults to Date.now for the
   *  worker, which is correct there: the worker feeds events in the same process off
   *  the same wall clock the TurnAssembler stamps turns with, so the binding loop's
   *  comparison stays one clock against itself. */
  now?: () => number;
  watchdogMs?: number;
  graceMs?: number;
  /** How the approved utterance is wrapped for the model's mouth. Defaults to the
   *  standing `speakTurnInstruction` — the owner-approved phrasing licence (substance
   *  verbatim, model owns delivery) already pinned by the realtime suite. Injectable so
   *  Step 1 can tune wording without touching the delivery mechanics pinned here. */
  instruction?: (utterance: string) => string;
  /** The model-turn gate (see `ModelTurnGate`). Absent = every say sends immediately —
   *  the pre-gate behaviour, kept for fakes that model no server pacing. The WORKER
   *  always injects the tracker; that wiring is the plumbing half of this fix. */
  turnGate?: ModelTurnGate;
  /** The stale-pair window (see `STALE_TURN_COMPLETE_WINDOW_MS`, the default). The
   *  worker injects the env override here — this module never reads `process.env`
   *  (the file-header doctrine). 0 disables the ignore entirely. */
  staleTurnCompleteWindowMs?: number;
  /** REVIEW-MANDATED (F3): called for EVERY turnComplete ignored as stale, with the
   *  delta-since-send and the pending-say state. The worker wires this to its log —
   *  the window's validation data comes from these lines. */
  onStaleTurnCompleteIgnored?: (info: StaleTurnCompleteIgnored) => void;
}

/** The per-say bookkeeping. One of these exists exactly while a say is in flight. */
interface PendingSay {
  resolve: (d: SpeechDelivery) => void;
  reject: (e: Error) => void;
  utterance: string;
  /** False while the say is PARKED behind the model-turn gate: the directive is not on
   *  the wire yet, so no event may settle this say and no frame may stamp it — frames
   *  arriving now belong to the IN-FLIGHT model turn (the e10a401-family
   *  misattribution the live log caught at +119.37s: the deferral's frames stamped a
   *  say armed mid-flight, polluting askedAt for a question nobody heard begin). */
  sent: boolean;
  /** The clock at the send (stamped in `armAndSend`, same synchronous tick as the
   *  directive hitting the wire) — the reference point for the stale-pair window. */
  sentAt: number | undefined;
  firstFrameAt: number | undefined;
  callerEvidence: boolean;
  /** Set when a terminal event said "no audio is coming" and the grace clock started —
   *  from then on, caller evidence settles barge-in immediately. */
  awaitingEvidence: boolean;
  /** The park's bound: fires at the gate's deadline so a server that withholds
   *  `turnComplete` past its own estimate cannot wedge the say forever. */
  sendWaitTimer: ReturnType<typeof setTimeout> | undefined;
  watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  graceTimer: ReturnType<typeof setTimeout> | undefined;
  /** What started the grace wait, for the honest-death message. */
  deathReason: string;
}

export class DirectSpeechChannel {
  private readonly host: DirectSpeechHost;
  private readonly now: () => number;
  private readonly watchdogMs: number;
  private readonly graceMs: number;
  private readonly instruction: (utterance: string) => string;
  private readonly turnGate: ModelTurnGate | undefined;
  private readonly staleTurnCompleteWindowMs: number;
  private readonly onStaleTurnCompleteIgnored: ((info: StaleTurnCompleteIgnored) => void) | undefined;
  private pending: PendingSay | undefined;
  /** The latch. Once set, no directive ever leaves this channel again. */
  private dead: { message: string } | undefined;

  constructor(host: DirectSpeechHost, opts?: DirectSpeechChannelOptions) {
    this.host = host;
    this.now = opts?.now ?? Date.now;
    this.watchdogMs = opts?.watchdogMs ?? SPEAK_WATCHDOG_MS;
    this.graceMs = opts?.graceMs ?? BARGE_IN_GRACE_MS;
    this.instruction = opts?.instruction ?? speakTurnInstruction;
    this.turnGate = opts?.turnGate;
    this.staleTurnCompleteWindowMs =
      opts?.staleTurnCompleteWindowMs ?? STALE_TURN_COMPLETE_WINDOW_MS;
    this.onStaleTurnCompleteIgnored = opts?.onStaleTurnCompleteIgnored;
  }

  /**
   * Speak one approved utterance: arm, send ONE DirectiveTurn carrying it verbatim
   * (inside the phrasing-licence instruction), then race the wire's events against the
   * watchdog. One at a time, enforced — this module must never have two speeches in
   * flight to supersede each other (#2059, the discipline the whole session file is
   * built on).
   */
  say(utterance: string): Promise<SpeechDelivery> {
    if (this.dead !== undefined) {
      return Promise.reject(
        new Error(
          `utterance ${JSON.stringify(utterance)} refused: the socket is gone ` +
            `(${this.dead.message}) — a directive into a dead socket is a fabricated delivery`,
        ),
      );
    }
    if (this.pending !== undefined) {
      return Promise.reject(
        new Error(
          `utterance ${JSON.stringify(utterance)} refused: another utterance is in flight ` +
            `(${JSON.stringify(this.pending.utterance)}) — one at a time, awaited (#2059)`,
        ),
      );
    }
    return new Promise<SpeechDelivery>((resolve, reject) => {
      const pending: PendingSay = {
        resolve,
        reject,
        utterance,
        sent: false,
        sentAt: undefined,
        firstFrameAt: undefined,
        callerEvidence: false,
        awaitingEvidence: false,
        sendWaitTimer: undefined,
        watchdogTimer: undefined,
        graceTimer: undefined,
        deathReason: "",
      };
      this.pending = pending;
      this.trySend(pending);
    });
  }

  /** Send the parked directive if the model-turn gate allows it, else (re-)park.
   *
   *  ARM AT THE SEND — the redesign the model-turn gate forces. The old rule was "arm
   *  BEFORE the send", written when arm and send were one synchronous block: its point
   *  was that no gap could exist in which OUR turn's audio landed unobserved. That
   *  property survives — arm (`sent = true`) and the send still happen in ONE
   *  synchronous tick with no await between them, so our turn's first frame is still
   *  observed from the first possible instant. What changed is the WAIT now sitting
   *  between say() and the send: frames arriving in that window belong to the
   *  IN-FLIGHT model turn, and arming before the wait would stamp them as this say's
   *  `firstFrameAt` — recreating exactly the misattribution this fix exists to kill
   *  (the live +119.37s pollution; DS13 pins it). Audio that arrived before the
   *  directive hit the wire must never produce a `voicedAt` — the e10a401 rule,
   *  carried to the send. */
  private trySend(p: PendingSay): void {
    if (this.pending !== p || p.sent) return;
    const deadline = this.parkBound();
    const t = this.now();
    if (deadline !== undefined && deadline > t) {
      // PARK: a model turn is in flight and a directive now would make the server
      // interrupt its own reply (the gate's header). `onTurnComplete` releases the
      // park early; this timer is the BOUND — at the (tracker-capped) deadline the
      // directive departs regardless, because progress beats politeness once the
      // server has run past its own estimate. A re-check that finds the deadline
      // moved (the turn accumulated more audio) re-parks; the tracker's absolute cap
      // guarantees the re-parking terminates.
      if (p.sendWaitTimer !== undefined) clearTimeout(p.sendWaitTimer);
      p.sendWaitTimer = setTimeout(() => {
        p.sendWaitTimer = undefined;
        this.trySendAtBound(p);
      }, deadline - t);
      return;
    }
    this.armAndSend(p);
  }

  /** The park's bound: the gate's deadline PLUS the finalize margin. The estimate held
   *  to ±4ms on the dry socket, so a bound that fires AT the estimate can still send a
   *  few ms before the real `turnComplete` — and the deletion-check run of the
   *  server-model suite showed exactly that race ending in the aborted turn's
   *  turnComplete landing on the fresh say and the honest-death throw killing the
   *  call. The margin (shared with the loop's extension — voice-agent-session.ts)
   *  waits past the measured jitter; the bound stays absolute. */
  private parkBound(): number | undefined {
    const deadline = this.turnGate?.sendWaitDeadline();
    return deadline === undefined ? undefined : deadline + MODEL_TURN_FINALIZE_MARGIN_MS;
  }

  /** The park's timer path: at the bound, send even if the gate still claims a turn is
   *  in flight — unless the deadline has legitimately MOVED forward (more audio
   *  accumulated), in which case re-park toward the new bound. */
  private trySendAtBound(p: PendingSay): void {
    if (this.pending !== p || p.sent) return;
    const deadline = this.parkBound();
    const t = this.now();
    if (deadline !== undefined && deadline > t) {
      p.sendWaitTimer = setTimeout(() => {
        p.sendWaitTimer = undefined;
        this.trySendAtBound(p);
      }, deadline - t);
      return;
    }
    this.armAndSend(p);
  }

  /** Arm and send in ONE synchronous tick — see `trySend`'s header. */
  private armAndSend(p: PendingSay): void {
    if (p.sendWaitTimer !== undefined) {
      clearTimeout(p.sendWaitTimer);
      p.sendWaitTimer = undefined;
    }
    p.sent = true;
    p.sentAt = this.now();
    this.host.sendDirective(directiveTurn(this.instruction(p.utterance)));
    p.watchdogTimer = setTimeout(() => this.onWatchdog(), this.watchdogMs);
  }

  // ─── the event feeds (called by the worker's socket translation) ───────────────────

  /** Model audio reached the output path. The FIRST since the SEND is `voicedAt` —
   *  later frames never move the stamp, and a frame before the directive hit the wire
   *  never produces one at all (it belongs to the in-flight model turn — the e10a401
   *  rule carried to the send; see `trySend`). */
  onAudioFrame(): void {
    const p = this.pending;
    if (p !== undefined && p.sent && p.firstFrameAt === undefined) p.firstFrameAt = this.now();
  }

  /** The caller barged in. With frames: the utterance was cut off mid-question —
   *  `partial`, the caller heard it begin. Without frames: the question was NEVER
   *  voiced and the caller is demonstrably present — the barge-in report the loop's
   *  drain path consumes. Either way an interrupt IS caller evidence.
   *
   *  While the say is still PARKED, nothing settles: our directive is not on the wire,
   *  so this interrupt is about the IN-FLIGHT model turn, not about us — settling
   *  would report a barge-in on a question that was never even sent. The evidence
   *  still counts (a caller who spoke is present), and the park continues to the
   *  finalize that follows an interrupt within milliseconds on the measured wire. */
  onInterrupted(): void {
    const p = this.pending;
    if (p === undefined) return;
    p.callerEvidence = true;
    if (!p.sent) return;
    if (p.firstFrameAt !== undefined) {
      this.settle(p, { delivered: false, partial: true, voicedAt: p.firstFrameAt });
    } else {
      this.settle(p, { delivered: false, partial: false });
    }
  }

  /** The turn closed. For a PARKED say this is the release: the in-flight model turn
   *  finalized, so the directive may depart now (`trySend` re-consults the gate — the
   *  worker feeds the tracker BEFORE this channel, so the gate is already clear).
   *  For a SENT say: with frames and no interrupt on the way, DELIVERED. Without
   *  frames: a generation that never made sound — grace for caller evidence, then the
   *  honest death (never delivered:true on silence; that is the fabricated report). */
  onTurnComplete(): void {
    const p = this.pending;
    if (p === undefined) return;
    if (!p.sent) {
      this.trySend(p);
      return;
    }
    if (p.firstFrameAt !== undefined) {
      this.settle(p, { delivered: true, voicedAt: p.firstFrameAt });
    } else {
      // B1 — the stale-pair ignore (see STALE_TURN_COMPLETE_WINDOW_MS): a no-frames
      // turnComplete this soon after OUR OWN send is the ABORTED turn's trailing
      // finalize riding behind an `interrupted`, not this say's completion — the
      // misread that killed three live calls. Ignored here IN THE CHANNEL (the
      // worker must keep feeding the assembler and the tracker every turnComplete),
      // and reported on every ignore (F3). Worst case accepted and stated at the
      // constant: a falsely-ignored genuine zero-audio TC waits under
      // SPEAK_WATCHDOG_MS (30s) and then settles honestly — up to 30s of dead air.
      const msSinceSend = p.sentAt === undefined ? undefined : this.now() - p.sentAt;
      if (msSinceSend !== undefined && msSinceSend < this.staleTurnCompleteWindowMs) {
        this.onStaleTurnCompleteIgnored?.({
          msSinceSend,
          utterance: p.utterance,
          awaitingEvidence: p.awaitingEvidence,
          callerEvidence: p.callerEvidence,
        });
        return;
      }
      this.awaitEvidenceOrDie(
        p,
        `utterance ${JSON.stringify(p.utterance)} silently failed: the turn completed ` +
          `but no audio ever reached the output path`,
      );
    }
  }

  /** A caller transcription fragment landed — evidence someone is talking to us. Only
   *  consulted on the no-frames paths; it never changes a delivered outcome. */
  onCallerFragment(): void {
    const p = this.pending;
    if (p === undefined) return;
    p.callerEvidence = true;
    if (p.awaitingEvidence && p.firstFrameAt === undefined) {
      this.settle(p, { delivered: false, partial: false });
    }
  }

  /** Sustained CLEAR caller energy fired (Fix A, 2026-08-24): the worker's evidence
   *  tracker (voice-caller-energy.ts — rms >= the evidence bar, not during our own
   *  playout, consecutive windows) heard the caller SPEAKING. On the fix-25 call the
   *  owner talked at rms 0.0511–0.0905 while Gemini returned ZERO transcript-in, so
   *  `onCallerFragment` never fired and the no-audio paths could only die — energy is
   *  the SAME evidence through a channel the model cannot silently drop. Identical
   *  contract to the fragment, deliberately: only consulted on the no-frames paths,
   *  and it can only ever produce `delivered:false` — `delivered:true` requires MODEL
   *  frames (the review's hard constraint: a dead output path with a chatty caller is
   *  a barge-in-shaped failure, never a delivery). */
  onCallerEnergy(): void {
    const p = this.pending;
    if (p === undefined) return;
    p.callerEvidence = true;
    if (p.awaitingEvidence && p.firstFrameAt === undefined) {
      this.settle(p, { delivered: false, partial: false });
    }
  }

  /** The socket closed. Latches the channel (see the header) and rejects any pending
   *  say — even a clean 1000: nothing can arrive any more. */
  onClosed(code: number, reason: string): void {
    const detail =
      code === 1000
        ? `socket closed cleanly (1000${reason ? `, ${JSON.stringify(reason)}` : ""}) mid-call`
        : `socket closed abnormally: code ${code}${reason ? `, ${JSON.stringify(reason)}` : ""}`;
    this.die(detail);
  }

  /** The socket errored. Always latches — an errored socket's later events are noise. */
  onError(message: string): void {
    this.die(`socket error: ${message}`);
  }

  // ─── internals ─────────────────────────────────────────────────────────────────────

  private onWatchdog(): void {
    const p = this.pending;
    if (p === undefined) return;
    if (p.firstFrameAt !== undefined) {
      // Audio left; the agent is merely slow (a long courteous turn must not kill the
      // call — the realtime precedent, voice-agent-session.ts:612-614). The answer
      // watchdog and MAX_CONSECUTIVE_SILENCES still bound a truly dead call behind us.
      this.settle(p, { delivered: true, voicedAt: p.firstFrameAt });
    } else {
      this.awaitEvidenceOrDie(
        p,
        `utterance ${JSON.stringify(p.utterance)} silently failed: the speak watchdog ` +
          `(${this.watchdogMs}ms) expired and no audio ever reached the output path`,
      );
    }
  }

  /** No audio is coming. Was the caller talking over us? Already-seen evidence settles
   *  barge-in now; otherwise the grace clock runs and `onCallerFragment`/`onInterrupted`
   *  can still settle it; expiry is the honest death. */
  private awaitEvidenceOrDie(p: PendingSay, deathReason: string): void {
    if (p.callerEvidence) {
      this.settle(p, { delivered: false, partial: false });
      return;
    }
    p.awaitingEvidence = true;
    p.deathReason = deathReason;
    if (p.graceTimer === undefined) {
      p.graceTimer = setTimeout(() => {
        if (this.pending !== p) return;
        // B2 (2026-08-24): audio that reached the output path while the grace clock
        // ran CANCELS the death — on live w-p1 the re-ask's audio flowed at +97806,
        // fully inside the grace window, and the old expiry threw "no audio ever
        // reached the output path" with the agent's own audio on the line. Frames
        // first, matching onTurnComplete and onWatchdog: the existing delivered
        // semantics, no new SpeechDelivery state (runApprovedScript branches on
        // `delivered || partial` with no exhaustive switch — a new variant would
        // silently route into the re-ask path).
        //
        // KNOWN AND ACCEPTED LIMITATION (F7): `onAudioFrame` stamps ANY post-send
        // frame, so the audio cancelling this death can be the model's AUTO-REPLY
        // rather than the re-ask's own voicing. That is the pre-existing
        // delivery-attribution shape of this channel (substance-not-verbatim is
        // settled); wiring the tracker's `directivePreceded` into settle is a
        // SEPARATE, later decision — not taken here.
        if (p.firstFrameAt !== undefined) {
          this.settle(p, { delivered: true, voicedAt: p.firstFrameAt });
        } else if (p.callerEvidence) {
          this.settle(p, { delivered: false, partial: false });
        } else {
          this.fail(p, new Error(`${p.deathReason} (no caller evidence within ${this.graceMs}ms)`));
        }
      }, this.graceMs);
    }
  }

  private die(message: string): void {
    if (this.dead === undefined) this.dead = { message };
    const p = this.pending;
    if (p !== undefined) {
      this.fail(
        p,
        new Error(`utterance ${JSON.stringify(p.utterance)} died mid-flight: ${message}`),
      );
    }
  }

  private settle(p: PendingSay, delivery: SpeechDelivery): void {
    this.clear(p);
    p.resolve(delivery);
  }

  private fail(p: PendingSay, err: Error): void {
    this.clear(p);
    p.reject(err);
  }

  private clear(p: PendingSay): void {
    if (p.sendWaitTimer !== undefined) clearTimeout(p.sendWaitTimer);
    if (p.watchdogTimer !== undefined) clearTimeout(p.watchdogTimer);
    if (p.graceTimer !== undefined) clearTimeout(p.graceTimer);
    if (this.pending === p) this.pending = undefined;
  }
}
