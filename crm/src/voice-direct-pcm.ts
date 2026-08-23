// Two pure audio helpers, each carrying a lesson BOUGHT on a live call (PROOF-spike.ts
// is the reference implementation; PROOF-direct-socket-all4-passed.log the call that
// proved the fixed versions).
//
// LESSON 1 — COPY OUT OF THE POOL (spike call #2, audible interference):
// `Buffer.from(b64, "base64")` returns a SLICE of Node's shared 8KB Buffer pool —
// `bytes.buffer` is the whole pool, not our bytes. Wrapping that in an Int16Array hands
// the audio source memory it does not own: later decodes land in the same pool, and a
// queued frame waits longer for its bytes to be clobbered, so the corruption got WORSE
// once frames were queued — heard as interference on the line (PROOF-spike.ts:146-156).
// A pooled offset can also be odd, which `new Int16Array(buffer, offset, len)` rejects
// outright. Copying into fresh memory gives an aligned buffer we own for the frame's
// whole life. The copy costs ~2KB per ~85ms frame — nothing against the alternative.
//
// LESSON 2 — ONE CAPTURE IN FLIGHT (spike call #1, "hello" then silence):
// `AudioSource.captureFrame` accepts exactly one concurrent capture; firing it per
// arriving frame killed 16 frames with `InvalidState - failed to capture frame`
// (PROOF-spike.ts:233-240). The fix that flew is a single-promise chain; `SerialQueue`
// is that chain with a name, an owner, and an error COUNTER — the spike logged capture
// errors and moved on, which is right for the pump but wrong for observability: a frame
// dropped invisibly is how "the caller heard silence" becomes undiagnosable.

/**
 * Decode base64 PCM16 into an Int16Array over OWNED, even-aligned memory.
 * The returned array's buffer is exactly `byteLength` long (never the shared pool) and
 * survives any number of later decodes unchanged — the property the live interference
 * bug violated. Throws on an odd byte count: half a sample is not audio, and letting
 * Int16Array's own RangeError surface later (or silently truncating) hides the real
 * defect, which is upstream of this function.
 */
export function ownedPcm16FromBase64(b64: string): Int16Array {
  const bytes = Buffer.from(b64, "base64"); // a pooled slice — NEVER wrapped directly
  if (bytes.byteLength % 2 !== 0) {
    throw new Error(
      `PCM16 payload has an odd byte length (${bytes.byteLength}): half a sample is not ` +
        `audio — refusing to truncate or misalign (the 1007 odd-byte family's cousin)`,
    );
  }
  const owned = new Uint8Array(bytes.byteLength); // fresh, exact-size, 0-offset memory
  owned.set(bytes);
  return new Int16Array(owned.buffer);
}

/**
 * A single-promise chain: tasks run strictly one at a time, in enqueue order — the
 * serialisation `AudioSource.captureFrame` requires (see LESSON 2). A task's failure is
 * SWALLOWED (the pump must outlive a dropped frame; captureFrame also applies its own
 * 1000ms backpressure and `clearQueue()` on barge-in drops what is unplayed) but every
 * failure is COUNTED and optionally reported, so the worker can log it and a dead
 * output path shows up as a climbing counter instead of unexplained silence.
 */
export class SerialQueue {
  private chain: Promise<void> = Promise.resolve();
  private errors = 0;
  private readonly onError: ((err: unknown) => void) | undefined;

  constructor(onError?: (err: unknown) => void) {
    this.onError = onError;
  }

  /** Run `task` after everything already enqueued. The returned promise resolves when
   *  THIS task has settled — it never rejects (the swallow-and-count contract above),
   *  so awaiting it cannot kill the caller's own loop. */
  enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(async () => {
      try {
        await task();
      } catch (err) {
        this.errors += 1;
        this.onError?.(err);
      }
    });
    this.chain = run;
    return run;
  }

  /** How many tasks have failed since construction. A test asserting "no throw" alone
   *  would pass with errors eaten AND with the chain wedged — the counter is what makes
   *  a swallowed failure observable. */
  errorCount(): number {
    return this.errors;
  }
}
