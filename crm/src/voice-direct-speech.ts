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
  SPEAK_WATCHDOG_MS,
  speakTurnInstruction,
  type SpeechDelivery,
} from "./voice-agent-session.js";
import { directiveTurn, type DirectiveTurn } from "./voice-direct-events.js";

/** What this channel needs from the worker's socket plumbing: the ability to put ONE
 *  DirectiveTurn on the wire. Structural on purpose (the containment rule) — the worker
 *  passes a closure over `session.sendClientContent`, tests pass an array-push. */
export interface DirectSpeechHost {
  sendDirective(turn: DirectiveTurn): void;
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
}

/** The per-say bookkeeping. One of these exists exactly while a say is in flight. */
interface PendingSay {
  resolve: (d: SpeechDelivery) => void;
  reject: (e: Error) => void;
  utterance: string;
  firstFrameAt: number | undefined;
  callerEvidence: boolean;
  /** Set when a terminal event said "no audio is coming" and the grace clock started —
   *  from then on, caller evidence settles barge-in immediately. */
  awaitingEvidence: boolean;
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
  private pending: PendingSay | undefined;
  /** The latch. Once set, no directive ever leaves this channel again. */
  private dead: { message: string } | undefined;

  constructor(host: DirectSpeechHost, opts?: DirectSpeechChannelOptions) {
    this.host = host;
    this.now = opts?.now ?? Date.now;
    this.watchdogMs = opts?.watchdogMs ?? SPEAK_WATCHDOG_MS;
    this.graceMs = opts?.graceMs ?? BARGE_IN_GRACE_MS;
    this.instruction = opts?.instruction ?? speakTurnInstruction;
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
      // Arm BEFORE the send: no window in which this turn's audio could land unobserved
      // (the same ordering realtimeScriptedSpeech pins at its observer.arm()).
      const pending: PendingSay = {
        resolve,
        reject,
        utterance,
        firstFrameAt: undefined,
        callerEvidence: false,
        awaitingEvidence: false,
        watchdogTimer: undefined,
        graceTimer: undefined,
        deathReason: "",
      };
      this.pending = pending;
      this.host.sendDirective(directiveTurn(this.instruction(utterance)));
      pending.watchdogTimer = setTimeout(() => this.onWatchdog(), this.watchdogMs);
    });
  }

  // ─── the event feeds (called by the worker's socket translation) ───────────────────

  /** Model audio reached the output path. The FIRST since arm is `voicedAt` — later
   *  frames never move the stamp. */
  onAudioFrame(): void {
    const p = this.pending;
    if (p !== undefined && p.firstFrameAt === undefined) p.firstFrameAt = this.now();
  }

  /** The caller barged in. With frames: the utterance was cut off mid-question —
   *  `partial`, the caller heard it begin. Without frames: the question was NEVER
   *  voiced and the caller is demonstrably present — the barge-in report the loop's
   *  drain path consumes. Either way an interrupt IS caller evidence. */
  onInterrupted(): void {
    const p = this.pending;
    if (p === undefined) return;
    p.callerEvidence = true;
    if (p.firstFrameAt !== undefined) {
      this.settle(p, { delivered: false, partial: true, voicedAt: p.firstFrameAt });
    } else {
      this.settle(p, { delivered: false, partial: false });
    }
  }

  /** The turn closed. With frames and no interrupt on the way: DELIVERED. Without
   *  frames: a generation that never made sound — grace for caller evidence, then the
   *  honest death (never delivered:true on silence; that is the fabricated report). */
  onTurnComplete(): void {
    const p = this.pending;
    if (p === undefined) return;
    if (p.firstFrameAt !== undefined) {
      this.settle(p, { delivered: true, voicedAt: p.firstFrameAt });
    } else {
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
        if (p.callerEvidence) {
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
    if (p.watchdogTimer !== undefined) clearTimeout(p.watchdogTimer);
    if (p.graceTimer !== undefined) clearTimeout(p.graceTimer);
    if (this.pending === p) this.pending = undefined;
  }
}
