// AudioEnergyMeter pins (AE1–AE12) — the instrument that makes "was the caller
// speaking?" decidable from a call log.
//
// WHY THIS EXISTS: three post-mortems in a row stalled on the same undecidable —
// `transcript-in` records what the MODEL returned, nothing records what the LINE
// carried, so every "silence" has been an inference. And the live echo hypothesis
// (our own playout re-entering the mic leg at −18..−28dB and producing phantom
// `interrupted` events) is detectable ONLY by correlating inbound energy with whether
// OUR audio was playing — we have no echo reference signal, because this server never
// sees the caller's speaker.
//
// WHAT WOULD MAKE THESE PINS VACUOUS, and the general guards:
//   · A meter that never closes a window passes any "all windows are quiet" claim —
//     every test asserts an EXACT window count first.
//   · An RMS that returns a constant (0, or 1, or the threshold itself) passes any
//     boolean speech/quiet claim — AE2 pins the NUMBER, to a band computed from the
//     synthetic signal's known amplitude, and is the deletion-check target.
//   · A correlation that hardcodes one bucket passes a single-direction test — AE6 and
//     AE7 assert BOTH buckets, exactly, in both directions.
import { describe, it, expect } from "vitest";
import { AudioEnergyMeter, type EnergyWindow } from "../src/voice-audio-energy.js";

const RATE = 16000;
const WINDOW_SAMPLES = 4800; // the default 300ms at 16kHz — recomputed here on purpose:
// if the module's default window drifts, every exact-count assertion below goes red
// TOGETHER, which is the correct loudness for a change to the instrument's time base.

function silence(n: number): Int16Array {
  return new Int16Array(n);
}

/** A 440Hz sine at `amp` — RMS is amp/√2 exactly, which is what lets AE2 pin the
 *  computed number instead of just a boolean. */
function sine(n: number, amp: number): Int16Array {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = Math.round(amp * Math.sin((2 * Math.PI * 440 * i) / RATE));
  }
  return out;
}

/** Feed `samples` in `frameSize`-sample frames (the worker feeds ~10ms telephony
 *  frames), collecting every closed window. */
function feed(
  meter: AudioEnergyMeter,
  samples: Int16Array,
  playout: boolean,
  frameSize = 160,
): EnergyWindow[] {
  const windows: EnergyWindow[] = [];
  for (let i = 0; i < samples.length; i += frameSize) {
    windows.push(...meter.onFrame(samples.subarray(i, i + frameSize), playout));
  }
  return windows;
}

describe("AudioEnergyMeter — windowing and RMS", () => {
  it("AE1: one second of silence closes exactly 3 windows, all quiet, zero RMS", () => {
    // VACUOUS IF only quietness were asserted: a meter that closes no windows has
    // nothing to misclassify. The exact counts (3 closed, 1600 samples pending) anchor
    // that the 300ms windowing actually ran over all 16000 samples.
    const meter = new AudioEnergyMeter({ sampleRate: RATE });
    const windows = feed(meter, silence(RATE), false);
    expect(windows.length).toBe(3);
    for (const w of windows) {
      expect(w.speechLike).toBe(false);
      expect(w.rms).toBe(0);
      expect(w.peak).toBe(0);
    }
    const s = meter.summary();
    expect(s.windows).toBe(3);
    expect(s.quietWindows).toBe(3);
    expect(s.speechWindows).toBe(0);
    expect(s.meanRms).toBe(0);
    expect(s.samples).toBe(RATE);
    expect(s.pendingSamples).toBe(RATE - 3 * WINDOW_SAMPLES);
    expect(s.audioMs).toBe(3 * 300);
  });

  it("AE2: a sine at amplitude 8000 measures RMS ≈ 0.1726 and peak ≈ 0.2441 — the NUMBER, not a boolean (deletion-check target)", () => {
    // A 440Hz sine's RMS is amp/√2 = 5656.9, normalized 5656.9/32768 = 0.17263; its
    // peak is 8000/32768 = 0.24414. VACUOUS IF asserted as speechLike alone: a meter
    // returning rms=1 for any nonzero input passes the boolean. The numeric bands are
    // what red on a broken sum-of-squares, a dropped sqrt, or a lost normalization —
    // each of those lands far outside ±0.005.
    const meter = new AudioEnergyMeter({ sampleRate: RATE });
    const windows = feed(meter, sine(WINDOW_SAMPLES, 8000), false);
    expect(windows.length).toBe(1);
    expect(windows[0]!.rms).toBeCloseTo(0.17263, 2);
    expect(Math.abs(windows[0]!.rms - 0.17263)).toBeLessThan(0.005);
    expect(Math.abs(windows[0]!.peak - 0.24414)).toBeLessThan(0.005);
    expect(windows[0]!.speechLike).toBe(true);
    const s = meter.summary();
    expect(s.speechWindows).toBe(1);
    expect(Math.abs(s.peakRms - windows[0]!.rms)).toBeLessThan(1e-9);
  });

  it("AE3: frame-size independence — 160-sample frames and one whole-second chunk measure IDENTICALLY", () => {
    // The worker feeds ~10ms frames; the tests often feed big chunks. If the
    // accumulator carried per-call state wrong (e.g. resetting at chunk edges), the two
    // would diverge. VACUOUS IF the signal were uniform: half loud / half silent makes
    // the window boundary land inside the signal, so a chunk-edge reset changes real
    // numbers.
    const signal = new Int16Array(RATE);
    signal.set(sine(WINDOW_SAMPLES, 9000), 0); // window 0 loud, rest silent
    const a = new AudioEnergyMeter({ sampleRate: RATE });
    const b = new AudioEnergyMeter({ sampleRate: RATE });
    feed(a, signal, false, 160);
    b.onFrame(signal, false);
    expect(JSON.stringify(a.summary())).toBe(JSON.stringify(b.summary()));
    expect(a.summary().speechWindows).toBe(1); // and the shared answer is the true one
  });
});

describe("AudioEnergyMeter — sustained-speech runs", () => {
  it("AE4: consecutive speech-like windows count up, reset on quiet, and a run crossing sustainedWindows scores ONE episode", () => {
    // The 'sustained speech' notion a barge-in gate would later need — measured here,
    // deciding nothing. VACUOUS IF only the longest run were asserted: a counter that
    // never resets also maxes at 3. The full per-window run sequence pins the reset.
    const meter = new AudioEnergyMeter({ sampleRate: RATE }); // sustainedWindows default 2
    const windows = [
      ...feed(meter, silence(2 * WINDOW_SAMPLES), false),
      ...feed(meter, sine(3 * WINDOW_SAMPLES, 8000), false),
      ...feed(meter, silence(2 * WINDOW_SAMPLES), false),
    ];
    expect(windows.map((w) => w.speechRun)).toEqual([0, 0, 1, 2, 3, 0, 0]);
    const s = meter.summary();
    expect(s.longestSpeechRunWindows).toBe(3);
    expect(s.sustainedSpeechEpisodes).toBe(1); // one run crossed the 2-window bar, once
  });

  it("AE5: a single-window burst is NOT sustained — episodes stay 0, longest run reads 1", () => {
    // The click/cough discriminator. VACUOUS IF the burst were shorter than the speech
    // threshold's reach (nothing to misclassify as sustained) — the burst here IS
    // speech-like for its whole window, so only the run-length logic keeps episodes 0.
    const meter = new AudioEnergyMeter({ sampleRate: RATE });
    feed(meter, silence(WINDOW_SAMPLES), false);
    feed(meter, sine(WINDOW_SAMPLES, 8000), false);
    feed(meter, silence(WINDOW_SAMPLES), false);
    const s = meter.summary();
    expect(s.speechWindows).toBe(1);
    expect(s.longestSpeechRunWindows).toBe(1);
    expect(s.sustainedSpeechEpisodes).toBe(0);
  });
});

describe("AudioEnergyMeter — playout correlation (the echo signature)", () => {
  it("AE6: speech-like energy ONLY while our playout is active reads as the echo signature — all speech windows land in the during-playout bucket", () => {
    // The dry-socket finding made measurable: our own output fed back at line level
    // produced phantom interruptions. With no echo reference signal, the ONLY
    // detectable signature is inbound energy that tracks our playout. VACUOUS IF the
    // clear bucket went unasserted: a meter crediting every speech window to
    // during-playout would pass the first expect alone; AE7 is the mirrored guard.
    const meter = new AudioEnergyMeter({ sampleRate: RATE });
    feed(meter, sine(2 * WINDOW_SAMPLES, 8000), true); // loud while WE play
    feed(meter, silence(2 * WINDOW_SAMPLES), false); //  quiet while we are silent
    const s = meter.summary();
    expect(s.speechWindowsDuringPlayout).toBe(2);
    expect(s.speechWindowsClear).toBe(0);
    expect(s.quietWindowsDuringPlayout).toBe(0);
  });

  it("AE7: speech-like energy while we are NOT playing is a real caller — all speech windows land in the clear bucket", () => {
    const meter = new AudioEnergyMeter({ sampleRate: RATE });
    feed(meter, silence(2 * WINDOW_SAMPLES), true); //   we play, line quiet (no echo)
    feed(meter, sine(2 * WINDOW_SAMPLES, 8000), false); // line loud on its own
    const s = meter.summary();
    expect(s.speechWindowsClear).toBe(2);
    expect(s.speechWindowsDuringPlayout).toBe(0);
    expect(s.quietWindowsDuringPlayout).toBe(2); // and the no-echo evidence is counted too
  });

  it("AE8: playout is tracked per SAMPLE and classified by majority — 60% playout reads during-playout, 40% reads clear", () => {
    // Playout ends mid-window on real calls. Majority classification (≥50% of the
    // window's samples) is the documented choice; the exact fraction survives on the
    // window either way, so the raw data outlives the classification. VACUOUS IF the
    // two windows had the same mix — the 60/40 vs 40/60 split is what makes a
    // hardcoded boolean fail one of them.
    const meter = new AudioEnergyMeter({ sampleRate: RATE });
    const windows: EnergyWindow[] = [];
    windows.push(...meter.onFrame(silence(2880), true)); //  window 0: 60% playout
    windows.push(...meter.onFrame(silence(1920), false));
    windows.push(...meter.onFrame(silence(1920), true)); //  window 1: 40% playout
    windows.push(...meter.onFrame(silence(2880), false));
    expect(windows.length).toBe(2);
    expect(windows[0]!.playoutFraction).toBeCloseTo(0.6, 5);
    expect(windows[0]!.duringPlayout).toBe(true);
    expect(windows[1]!.playoutFraction).toBeCloseTo(0.4, 5);
    expect(windows[1]!.duringPlayout).toBe(false);
  });
});

describe("AudioEnergyMeter — defensive input (the odd-byte family's cousin, observer edition)", () => {
  it("AE9: an empty frame closes nothing and crashes nothing", () => {
    // VACUOUS IF nothing followed the empty frame: a meter that corrupted its
    // accumulator on empty input would still 'not crash'. The full window fed AFTER
    // the empty frame must still measure exactly — that is the assertion with teeth.
    const meter = new AudioEnergyMeter({ sampleRate: RATE });
    expect(meter.onFrame(new Int16Array(0), false)).toEqual([]);
    const windows = feed(meter, sine(WINDOW_SAMPLES, 8000), false);
    expect(windows.length).toBe(1);
    expect(Math.abs(windows[0]!.rms - 0.17263)).toBeLessThan(0.005);
  });

  it("AE10: an odd-length byte buffer is COUNTED and its even prefix still measured — never a throw (the pump must outlive the instrument)", () => {
    // Upstream, an odd byte count is a session-killing 1007 and voice-direct-pcm
    // THROWS on it — correct for playback, wrong for an observer: a meter throw would
    // kill the pump it watches, making the instrument affect the audio it measures.
    // VACUOUS IF only 'no throw' were asserted (an early-return passes that with the
    // byte path deleted): the closed window's known RMS and the oddByteChunks counter
    // are the teeth. 9601 bytes = 4800 samples of constant 8000 (+1 stray byte), and a
    // constant signal's RMS IS its amplitude: 8000/32768 = 0.24414.
    const meter = new AudioEnergyMeter({ sampleRate: RATE });
    const bytes = Buffer.alloc(WINDOW_SAMPLES * 2 + 1);
    for (let i = 0; i < WINDOW_SAMPLES; i += 1) bytes.writeInt16LE(8000, i * 2);
    bytes[WINDOW_SAMPLES * 2] = 0x7f; // the stray half-sample
    const windows = meter.onFrame(bytes, false);
    expect(windows.length).toBe(1);
    expect(Math.abs(windows[0]!.rms - 0.24414)).toBeLessThan(0.001);
    expect(meter.summary().oddByteChunks).toBe(1);
    expect(meter.summary().samples).toBe(WINDOW_SAMPLES);
  });
});

describe("AudioEnergyMeter — configuration is validated and load-bearing", () => {
  it("AE11: nonsense options are refused at construction, loudly — a mis-wired instrument must die at composition, not mismeasure a live call", () => {
    expect(() => new AudioEnergyMeter({ sampleRate: RATE, windowMs: 0 })).toThrow(/window/i);
    expect(
      () => new AudioEnergyMeter({ sampleRate: RATE, speechRmsThreshold: Number.NaN }),
    ).toThrow(/threshold/i);
    expect(
      () => new AudioEnergyMeter({ sampleRate: RATE, speechRmsThreshold: 1.5 }),
    ).toThrow(/threshold/i);
    expect(() => new AudioEnergyMeter({ sampleRate: 0 })).toThrow(/sampleRate/i);
  });

  it("AE12: the threshold is configurable AND consulted — the same signal flips classification when the bar moves past its RMS", () => {
    // The calibration story depends on this: the default is PROVISIONAL (our 8kHz
    // telephony leg upsampled to 16k does not carry a clean-mic product's levels), so
    // the threshold must be swappable once measured. VACUOUS IF both meters agreed —
    // the signal's RMS (≈0.0173 at amp 800) sits between the two bars on purpose.
    const soft = sine(WINDOW_SAMPLES, 800); // RMS ≈ 0.01726
    const strict = new AudioEnergyMeter({ sampleRate: RATE, speechRmsThreshold: 0.03 });
    const lenient = new AudioEnergyMeter({ sampleRate: RATE, speechRmsThreshold: 0.01 });
    expect(feed(strict, soft, false)[0]!.speechLike).toBe(false);
    expect(feed(lenient, soft, false)[0]!.speechLike).toBe(true);
  });
});
