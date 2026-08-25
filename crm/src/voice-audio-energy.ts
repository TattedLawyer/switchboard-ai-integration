// AudioEnergyMeter — the instrument that makes "was the caller SPEAKING?" decidable
// from a call log. Pure arithmetic over PCM16 samples: no vendor imports, no I/O, no
// clock (the sample count IS the clock — audio time is samples/sampleRate, which is
// what makes every test deterministic with synthetic frames).
//
// WHY THIS EXISTS — three post-mortems stalled on the same missing measurement:
//   1. A live call returned 2 caller transcripts in 88s while ~8,700 audio frames
//      arrived. Talking, or not? The log could not say.
//   2. An `[interrupted]` with NO caller transcript and no queued caller turn. Real
//      barge-in, line echo, or a VAD false positive? The log could not say.
//   3. A 15.8s "silence" after an answer. Did the caller actually speak? Same wall.
// The log records `transcript-in` — words the MODEL returned — and nothing about the
// audio itself, so every "silence" so far has been an INFERENCE.
//
// THE ECHO SIGNATURE: on a dry socket, feeding the agent's own output back at
// −18..−28dB produced phantom `interrupted` events and the model re-answering itself.
// Our server never sees the caller's speaker, so there is NO reference signal to
// subtract — the only detectable signature of line echo is inbound energy that appears
// (predominantly) WHILE OUR OWN AUDIO IS PLAYING. Hence the per-sample playout flag and
// the four-bucket correlation in the summary: speech-during-playout with a silent
// clear bucket is what echo looks like; speech in the clear bucket is a real caller.
//
// 🚨 CONTENT NEVER ENTERS. This module accepts samples and booleans and emits levels,
// counts and (audio-)timestamps — nothing else, structurally: there is no field, on
// any input or output type, that could carry transcript text or caller words. Caller
// content belongs in crm.answers under the broker's grants, never in process stdout.
//
// OBSERVER, NOT GATE: nothing here decides anything about audio flow. The
// sustained-run counters exist because a barge-in gate would NEED them — measuring
// them now is how a later gate gets designed from data instead of guesses — but that
// gate is a separate, unapproved decision and no flag or threshold in this file feeds
// back into the pump. (Fix A, 2026-08-24: the closed windows this module emits ARE
// now consumed as SECONDARY caller evidence — the decision lives in
// voice-caller-energy.ts, with its own separately-tunable threshold, never here.)
//
// ── THE CALIBRATION PROBLEM, honestly ────────────────────────────────────────────────
// Our inbound leg is 8kHz-codec telephony (PCMU/PCMA through the SIP bridge) upsampled
// to 16k for Gemini: everything above ~4kHz is GONE and unrecoverable, codec companding
// reshapes what remains, and trunk-side loss/AGC varies per carrier. A threshold
// borrowed from a clean-16k-microphone product does NOT transfer — AgenticYap ships
// RMS 0.06 with 4 consecutive frames on exactly such a leg, and that number is cited
// here only as the reference point we must NOT copy. The FIRST purpose of this
// instrument is to MEASURE what our real line looks like (the per-window RMS
// distribution, quiet floor and speech peaks, on live calls) so a threshold can be
// chosen from data. Until then:
//   · DEFAULT_SPEECH_RMS_THRESHOLD = 0.03 — PROVISIONAL: half the clean-mic reference,
//     on the reasoning that the missing 4–8kHz band and codec companding can only
//     LOWER observed RMS, never raise it. It labels windows in logs; it decides
//     nothing. Configurable at construction (the worker exposes an env override).
//   · DEFAULT_WINDOW_MS = 300 — chosen, not measured, for these reasons: telephony
//     frames arrive at ~10ms, so a 300ms window integrates ~30 frames and irons out
//     frame-level jitter; syllables run ~100–250ms, so one window spans a syllable or
//     two rather than slicing inside one; and the live VAD's silenceDurationMs is
//     500ms, so a model-detected pause always spans at least one whole quiet window —
//     the meter's timeline stays comparable with the VAD's. Shorter (say 100ms) would
//     resolve more structure but triple the log volume and make single windows too
//     noisy to threshold; longer (1s) would blur exactly the barge-in-scale events
//     cases 2 and 3 need resolved.
//   · DEFAULT_SUSTAINED_WINDOWS = 2 — 600ms of continuous speech-like energy. A cough,
//     click or echo-tail burst tops out under one window; anything a human says on
//     purpose crosses two. Again: a measurement bucket, not a gate.
//
// DEFENSIVE BY ROLE, not by copy-paste: voice-direct-pcm.ts THROWS on an odd byte
// count, correctly — half a sample fed to PLAYBACK is corruption (the 1007 family).
// This module inverts that, also correctly: an observer that throws kills the pump it
// watches, making the instrument affect the audio it measures. Odd bytes are COUNTED
// (`oddByteChunks`) and the even prefix is still measured; empty input is a no-op.

/** Everything measured about one closed fixed-duration window. Levels, counts and
 *  audio-time stamps ONLY — see the content rule in the header. */
export interface EnergyWindow {
  /** 0-based window ordinal. */
  index: number;
  /** Audio-time window edges in ms since the first sample (samples/rate — no wall
   *  clock; the caller can anchor these to its own t0 for logging). */
  startMs: number;
  endMs: number;
  /** Root-mean-square of the window's samples, normalized to [0,1] full-scale. */
  rms: number;
  /** Largest |sample| in the window, normalized to [0,1] full-scale. */
  peak: number;
  /** rms >= the configured threshold. A LABEL for logs and distributions — provisional
   *  until the threshold is chosen from live data (header). */
  speechLike: boolean;
  /** Length of the consecutive speech-like run this window ends (0 when quiet). */
  speechRun: number;
  /** Fraction of this window's samples fed while OUR outbound audio was playing. */
  playoutFraction: number;
  /** Majority classification: playoutFraction >= 0.5. The exact fraction is right
   *  beside it, so the raw data outlives the cutoff choice. */
  duringPlayout: boolean;
}

/** The end-of-call rollup — enough to answer "was the caller speaking" and "did
 *  inbound energy track OUR playout" (the echo signature) from one log line. */
export interface EnergySummary {
  windows: number;
  quietWindows: number;
  speechWindows: number;
  /** Mean of the closed windows' RMS values (0 when no window closed). */
  meanRms: number;
  /** Largest window RMS seen. */
  peakRms: number;
  /** Largest normalized |sample| seen anywhere, closed windows or pending. */
  peakSample: number;
  longestSpeechRunWindows: number;
  /** Distinct runs that reached `sustainedWindows` length (each counted once). */
  sustainedSpeechEpisodes: number;
  /** The echo-correlation buckets (majority-classified per window):
   *  speech that overlapped our playout vs speech in the clear — and quiet-during-
   *  playout, the no-echo evidence. */
  speechWindowsDuringPlayout: number;
  speechWindowsClear: number;
  quietWindowsDuringPlayout: number;
  /** Total samples measured (pending window included). */
  samples: number;
  /** Samples accumulated toward the not-yet-closed window. */
  pendingSamples: number;
  /** Audio time covered by CLOSED windows, in ms. */
  audioMs: number;
  /** Chunks that arrived as raw bytes with an odd length — counted, prefix measured
   *  (the observer's inversion of voice-direct-pcm's throw; header). */
  oddByteChunks: number;
}

export interface AudioEnergyMeterOptions {
  /** Samples per second of the fed PCM (the worker feeds Gemini's 16k input leg). */
  sampleRate: number;
  /** Window length in ms. Default 300 — justified in the header. */
  windowMs?: number;
  /** Normalized RMS at/above which a window is labeled speech-like. Default 0.03 —
   *  PROVISIONAL, see the calibration section of the header. */
  speechRmsThreshold?: number;
  /** Consecutive speech-like windows that make a run "sustained". Default 2. */
  sustainedWindows?: number;
}

export const DEFAULT_WINDOW_MS = 300;
export const DEFAULT_SPEECH_RMS_THRESHOLD = 0.03;
export const DEFAULT_SUSTAINED_WINDOWS = 2;

const FULL_SCALE = 32768; // |Int16| max magnitude; −32768 clamps to 1.0 on purpose

export class AudioEnergyMeter {
  private readonly windowSamples: number;
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly sustainedWindows: number;

  // The open window's accumulators.
  private sumSquares = 0;
  private winPeakAbs = 0;
  private winSamples = 0;
  private winPlayoutSamples = 0;

  // The rollup.
  private closed = 0;
  private quiet = 0;
  private speech = 0;
  private rmsSum = 0;
  private rmsPeak = 0;
  private absPeak = 0;
  private run = 0;
  private longestRun = 0;
  private episodes = 0;
  private speechDuringPlayout = 0;
  private speechClear = 0;
  private quietDuringPlayout = 0;
  private totalSamples = 0;
  private oddBytes = 0;

  constructor(options: AudioEnergyMeterOptions) {
    const {
      sampleRate,
      windowMs = DEFAULT_WINDOW_MS,
      speechRmsThreshold = DEFAULT_SPEECH_RMS_THRESHOLD,
      sustainedWindows = DEFAULT_SUSTAINED_WINDOWS,
    } = options;
    // A mis-wired instrument must die at COMPOSITION, before it mismeasures a live
    // call — the same loud-or-not-at-all rule the worker applies to its own env.
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new Error(`AudioEnergyMeter: sampleRate must be a positive number (got ${sampleRate})`);
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error(`AudioEnergyMeter: windowMs must be a positive number (got ${windowMs})`);
    }
    if (!Number.isFinite(speechRmsThreshold) || speechRmsThreshold <= 0 || speechRmsThreshold >= 1) {
      throw new Error(
        `AudioEnergyMeter: speechRmsThreshold must be in (0,1) normalized full-scale ` +
          `(got ${speechRmsThreshold})`,
      );
    }
    if (!Number.isInteger(sustainedWindows) || sustainedWindows < 1) {
      throw new Error(
        `AudioEnergyMeter: sustainedWindows must be a positive integer (got ${sustainedWindows})`,
      );
    }
    this.windowSamples = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
    this.windowMs = windowMs;
    this.threshold = speechRmsThreshold;
    this.sustainedWindows = sustainedWindows;
  }

  /**
   * Feed one inbound chunk with the playout flag that was true when it arrived
   * (`playoutActive` = our outbound source still holds unplayed audio — our voice is
   * on the line). Returns every window the chunk CLOSED (usually none or one; a chunk
   * larger than a window closes several). Never throws on malformed input — the
   * observer contract (header): Int16Array is the worker's native shape; raw bytes are
   * accepted defensively, odd lengths counted and measured to their even prefix.
   */
  onFrame(chunk: Int16Array | Uint8Array, playoutActive: boolean): EnergyWindow[] {
    const samples = chunk instanceof Int16Array ? chunk : this.bytesToSamples(chunk);
    const out: EnergyWindow[] = [];
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(this.windowSamples - this.winSamples, samples.length - offset);
      const end = offset + take;
      let sq = this.sumSquares;
      let pk = this.winPeakAbs;
      for (let i = offset; i < end; i += 1) {
        const s = samples[i]!;
        sq += s * s;
        const a = s < 0 ? -s : s;
        if (a > pk) pk = a;
      }
      this.sumSquares = sq;
      this.winPeakAbs = pk;
      this.winSamples += take;
      if (playoutActive) this.winPlayoutSamples += take;
      this.totalSamples += take;
      offset = end;
      if (this.winSamples === this.windowSamples) out.push(this.closeWindow());
    }
    return out;
  }

  /** The rollup so far — closed windows plus the pending remainder's bookkeeping.
   *  Cheap enough to log at any cadence. */
  summary(): EnergySummary {
    return {
      windows: this.closed,
      quietWindows: this.quiet,
      speechWindows: this.speech,
      meanRms: this.closed === 0 ? 0 : this.rmsSum / this.closed,
      peakRms: this.rmsPeak,
      peakSample: Math.min(1, Math.max(this.absPeak, this.winPeakAbs) / FULL_SCALE),
      longestSpeechRunWindows: this.longestRun,
      sustainedSpeechEpisodes: this.episodes,
      speechWindowsDuringPlayout: this.speechDuringPlayout,
      speechWindowsClear: this.speechClear,
      quietWindowsDuringPlayout: this.quietDuringPlayout,
      samples: this.totalSamples,
      pendingSamples: this.winSamples,
      audioMs: this.closed * this.windowMs,
      oddByteChunks: this.oddBytes,
    };
  }

  private closeWindow(): EnergyWindow {
    const n = this.windowSamples;
    const rms = Math.min(1, Math.sqrt(this.sumSquares / n) / FULL_SCALE);
    const peak = Math.min(1, this.winPeakAbs / FULL_SCALE);
    const speechLike = rms >= this.threshold;
    const playoutFraction = this.winPlayoutSamples / n;
    const duringPlayout = playoutFraction >= 0.5;

    if (speechLike) {
      this.speech += 1;
      this.run += 1;
      if (this.run > this.longestRun) this.longestRun = this.run;
      if (this.run === this.sustainedWindows) this.episodes += 1; // each run scores once
      if (duringPlayout) this.speechDuringPlayout += 1;
      else this.speechClear += 1;
    } else {
      this.quiet += 1;
      this.run = 0;
      if (duringPlayout) this.quietDuringPlayout += 1;
    }
    this.rmsSum += rms;
    if (rms > this.rmsPeak) this.rmsPeak = rms;
    if (this.winPeakAbs > this.absPeak) this.absPeak = this.winPeakAbs;

    const window: EnergyWindow = {
      index: this.closed,
      startMs: this.closed * this.windowMs,
      endMs: (this.closed + 1) * this.windowMs,
      rms,
      peak,
      speechLike,
      speechRun: speechLike ? this.run : 0,
      playoutFraction,
      duringPlayout,
    };
    this.closed += 1;
    this.sumSquares = 0;
    this.winPeakAbs = 0;
    this.winSamples = 0;
    this.winPlayoutSamples = 0;
    return window;
  }

  /** Raw bytes → PCM16 samples, little-endian, via DataView (a Uint8Array's byteOffset
   *  may be odd-aligned — the pooled-slice lesson of voice-direct-pcm, observer
   *  edition). An odd byte length is counted and its even prefix measured. */
  private bytesToSamples(bytes: Uint8Array): Int16Array {
    if (bytes.byteLength % 2 !== 0) this.oddBytes += 1;
    const n = Math.floor(bytes.byteLength / 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
    const out = new Int16Array(n);
    for (let i = 0; i < n; i += 1) out[i] = view.getInt16(i * 2, true);
    return out;
  }
}
