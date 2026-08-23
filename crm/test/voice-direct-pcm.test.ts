// Direct-socket PCM pins (PC1–PC6) — the two live-bought audio lessons from the proof
// call, made red-able (PROOF-spike.ts, the winning call in
// PROOF-direct-socket-all4-passed.log):
//
//   LESSON 1 — COPY, never a view. `Buffer.from(b64, "base64")` returns a slice of
//   Node's SHARED 8KB pool: `bytes.buffer` is that whole pool, and later decodes land in
//   it. Wrapping the pool directly (as spike call #2 did) handed the audio source memory
//   that was rewritten underneath queued frames — audible as INTERFERENCE on the line —
//   and a pooled offset can make `Int16Array` throw outright (the 1007 odd-byte family's
//   cousin). The pin is structural AND behavioural: the returned array must own exactly
//   its own bytes (PC2), and hammering the pool afterwards must not change what was
//   decoded (PC3).
//
//   LESSON 2 — SERIALISE captureFrame. The first live call fired captureFrame per
//   arriving frame and 16 died `InvalidState - failed to capture frame`: the source
//   accepts one capture at a time, and the caller heard "hello" then silence. SerialQueue
//   is the single-promise chain the spike shipped (PROOF-spike.ts:224, :237-241), with an
//   error counter so a dropped frame is COUNTED, never invisible.
import { describe, it, expect } from "vitest";
import { ownedPcm16FromBase64, SerialQueue } from "../src/voice-direct-pcm.js";

/** Little-endian PCM16 → base64, the exact wire shape Gemini's inlineData carries. */
function pcmBase64(samples: number[]): string {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf.toString("base64");
}

/** A deterministic non-trivial sample pattern, sized to stay POOLED (Node pools
 *  allocations under Buffer.poolSize/2 = 4096 bytes; 1024 samples = 2048 bytes). A
 *  payload over the pooling threshold would get its own buffer and make every view
 *  mutation invisibly safe — the pooled size is what keeps these pins non-vacuous. */
function pattern(seed: number, n = 1024): number[] {
  return Array.from({ length: n }, (_, i) => (((i * 31 + seed * 977) % 60000) - 30000) | 0);
}

describe("ownedPcm16FromBase64 — owned, even-aligned copies out of the Buffer pool", () => {
  it("PC1: decodes little-endian PCM16 to the exact sample values", () => {
    // VACUOUS ALONE: a pool view over freshly-decoded bytes also passes value equality
    // on a single decode — this pin only anchors the decode itself; PC2/PC3 carry the
    // copy-vs-view distinction.
    const samples = pattern(1);
    const out = ownedPcm16FromBase64(pcmBase64(samples));
    expect(out.length).toBe(samples.length);
    expect(Array.from(out)).toEqual(samples);
  });

  it("PC2: the returned array OWNS exactly its own bytes — never the shared pool", () => {
    // A pooled view's .buffer is Node's whole 8KB pool (byteLength 8192 for a 2048-byte
    // payload) — this is the deterministic tripwire for the offset-bounded view
    // mutation, which PC3's pool-hammering cannot reliably catch because Node never
    // re-issues pool space it already handed out. VACUOUS IF the payload exceeded the
    // 4096-byte pooling threshold: an unpooled Buffer's .buffer is already exact-sized,
    // and the assertion would pass with the copy deleted. 2048 bytes keeps it pooled.
    const out = ownedPcm16FromBase64(pcmBase64(pattern(2)));
    expect(out.buffer.byteLength).toBe(out.byteLength);
    expect(out.byteOffset).toBe(0);
  });

  it("PC3: decode A, then hammer the pool with B decodes — A's samples UNCHANGED", () => {
    // The live interference bug, made red-able: a view whose range covers pool space
    // that LATER decodes write into shows B's bytes inside A. VACUOUS IF asserted after
    // zero further decodes (nothing would have clobbered anything) or with A unpooled —
    // the 64 pooled B-decodes are the clobber pressure that makes the copy load-bearing.
    const samplesA = pattern(3);
    const a = ownedPcm16FromBase64(pcmBase64(samplesA));
    const snapshot = Array.from(a);
    const b64B = pcmBase64(pattern(4));
    for (let i = 0; i < 64; i += 1) Buffer.from(b64B, "base64"); // fills pools past A's
    expect(Array.from(a)).toEqual(snapshot);
    expect(Array.from(a)).toEqual(samplesA);
  });

  it("PC4: an odd byte count throws loudly — never a silently misaligned Int16Array", () => {
    // 3 decoded bytes cannot be whole PCM16 samples. VACUOUS IF the input were even
    // (nothing to refuse) or if we only asserted "some error": pin the message so a
    // future refactor that lets Int16Array's own RangeError leak (or truncates a byte
    // silently) goes red, not just differently-wrong.
    const odd = Buffer.from([1, 2, 3]).toString("base64");
    expect(() => ownedPcm16FromBase64(odd)).toThrow(/odd/i);
  });
});

describe("SerialQueue — one capture in flight, ever", () => {
  /** A promise whose settlement the TEST owns. A synchronously-resolving fake would
   *  finish each task before the next enqueue, making overlap UNOBSERVABLE — every
   *  concurrency assertion below would pass with the queue deleted. Deferreds are the
   *  anti-vacuity mechanism of this whole describe block. */
  function deferred() {
    let resolve!: () => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  const tick = () => new Promise<void>((r) => setImmediate(r));

  it("PC5: tasks run strictly one at a time, in enqueue order", async () => {
    // VACUOUS IF maxActive were computed after settlement only, or if the deferreds
    // resolved synchronously (see above): the mid-flight assertions — b NOT started
    // while a holds its deferred — are what a concurrent-dispatch mutation trips on.
    const q = new SerialQueue();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const task = (name: string, d: ReturnType<typeof deferred>) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`${name}:start`);
      await d.promise;
      order.push(`${name}:end`);
      active -= 1;
    };
    const d1 = deferred();
    const d2 = deferred();
    const d3 = deferred();
    const p1 = q.enqueue(task("a", d1));
    const p2 = q.enqueue(task("b", d2));
    const p3 = q.enqueue(task("c", d3));
    await tick();
    expect(order).toEqual(["a:start"]); // b enqueued but NOT started: a is in flight
    d1.resolve();
    await tick();
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
    d2.resolve();
    await tick();
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start"]);
    d3.resolve();
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
    expect(maxActive).toBe(1); // the InvalidState bug is exactly maxActive > 1
  });

  it("PC6: a failing task is COUNTED and the chain survives it", async () => {
    // The spike swallowed capture errors into a log line (PROOF-spike.ts:240); the
    // module keeps the swallow (a dropped frame must not kill the pump) but COUNTS it —
    // a test asserting only "no throw" would pass with the error silently eaten AND
    // with the chain wedged. VACUOUS IF the follow-up task were not asserted to run:
    // that half is what catches a chain that dies at the first rejection.
    const q = new SerialQueue();
    expect(q.errorCount()).toBe(0);
    await q.enqueue(async () => {
      throw new Error("InvalidState - failed to capture frame");
    });
    expect(q.errorCount()).toBe(1);
    let ran = false;
    await q.enqueue(async () => {
      ran = true;
    });
    expect(ran).toBe(true); // the chain survived the failure
    expect(q.errorCount()).toBe(1); // and the success did not count as an error
  });
});
