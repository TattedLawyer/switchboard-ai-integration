// Local-embedder pins — the OFFLINE, prefix-asymmetric, 1024-pinned contract (plan C6).
//
// 🚨 THE TRIPWIRE IS INSTALLED VIA `vi.hoisted`, and that is load-bearing, measured the
// hard way: Transformers.js BINDS `globalThis.fetch` into `env.fetch` at ITS module load
// (transformers.node.mjs:99, `DEFAULT_FETCH = … globalThis.fetch.bind(globalThis)`), and
// ESM hoisting runs every import before this file's body. A stub assigned in the module
// body therefore replaces a function the library no longer consults — this suite's first
// version did exactly that, and a deliberate mutation (allowRemoteModels=true + hub id)
// downloaded 560MB straight through the "stub" (observed 2026-08-19, 77s run). Only a
// hoisted stub is bound by the library, so only a hoisted stub actually trips.
//
// C6's driver is RA 10173 — her business knowledge must not leave her deployment — so
// "the embedder never touches the network" is not a preference, it is the product claim.
// A test that merely asserts `allowRemoteModels === false` would pin a flag, not a
// behavior; this pins the behavior: if anything in the model-load or embed path reaches
// for the network, the whole suite dies with NETWORK ACCESS IN A TEST.
//
// No database here — these pins are about the model, the prefixes, and the vendored
// weights. The DB arity pin lives in migration-023.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const realFetch = vi.hoisted(() => {
  const real = globalThis.fetch;
  globalThis.fetch = ((..._args: unknown[]) => {
    throw new Error("NETWORK ACCESS IN A TEST — the local embedder must never touch the network");
  }) as typeof fetch;
  return real;
});
import { EMBED_DIM } from "../src/kb/dimensions.js";
import {
  createEmbedder,
  MODEL_DIR_NAME,
  MODEL_REVISION,
  type Embedder,
} from "../src/kb/embedder.js";

let embedder: Embedder;

beforeAll(async () => {
  // ONE construction for the whole file — the process-start load the composition root
  // will do (call-transport.ts doctrine: it throws at CONSTRUCTION, not per call).
  embedder = await createEmbedder();
}, 180_000);

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("kb embedder: dimension pin", () => {
  // P2. Two halves on purpose: the constant catches a config edit; the REAL embed run
  //     catches a model swap the constant cannot. mutations, RUN ✅ 2026-08-19:
  //   (a) EMBED_DIM = 384 in dimensions.ts -> AssertionError: expected 384 to be 1024
  //       (and every embed died 'model returned 1024 dimensions, not the pinned 384').
  //   (b) model-swap simulation — embed() returns data.slice(0, 512) with the runtime
  //       arity guard disabled -> AssertionError: expected [ 0.0205…, …(511) ] to have a
  //       length of 1024 but got 512. The pin sees the model's REAL output, not a
  //       constant. Restored, green.
  it("EMBED_DIM is 1024 and a real embedPassage returns exactly 1024 finite numbers", async () => {
    expect(EMBED_DIM).toBe(1024);
    const v = await embedder.embedPassage("probe");
    expect(v).toHaveLength(1024);
    for (const x of v) expect(Number.isFinite(x)).toBe(true);
  }, 60_000);

  it("vectors are L2-normalized, so pgvector's cosine ops get what they assume", async () => {
    const v = await embedder.embedPassage("Alabang Hills 3BR house-and-lot, ₱18.5M");
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 3);
  }, 60_000);
});

describe("kb embedder: e5 prefix asymmetry", () => {
  // P3. e5's asymmetric training: "query: " on questions, "passage: " on stored text.
  //     Getting this wrong DOES NOT ERROR — it silently degrades retrieval — so the
  //     asymmetry itself is pinned. mutation, RUN ✅ 2026-08-19: embedQuery mutated to
  //     use PASSAGE_PREFIX -> AssertionError: expected 0 to be greater than 0.0001 —
  //     the two vectors were IDENTICAL (maxDelta exactly 0, which also demonstrates the
  //     determinism the sibling test pins). Restored, green.
  it("embedQuery and embedPassage produce DIFFERENT vectors for identical text", async () => {
    const text = "May bakante pa ba sa Alabang Hills?";
    const q = await embedder.embedQuery(text);
    const p = await embedder.embedPassage(text);
    expect(q).toHaveLength(1024);
    expect(p).toHaveLength(1024);
    const maxDelta = Math.max(...q.map((x, i) => Math.abs(x - p[i])));
    expect(maxDelta).toBeGreaterThan(1e-4);
  }, 60_000);

  it("the same function is deterministic — one text, one vector", async () => {
    const a = await embedder.embedQuery("saan ang office niyo?");
    const b = await embedder.embedQuery("saan ang office niyo?");
    expect(a).toEqual(b);
  }, 60_000);
});

describe("kb embedder: offline + vendoring", () => {
  // P4. The hoisted tripwire is live for EVERY load and embed in this suite; this test
  //     names the claim. mutation, RUN ✅ 2026-08-19 (allowRemoteModels = true + empty
  //     localModelPath + guard removed + hub id):
  //       Error: NETWORK ACCESS IN A TEST — the local embedder must never touch the
  //       network   ❯ getFile transformers.node.mjs:6480 ❯ loadResourceFile :6614
  //     — thrown from INSIDE the library's remote path, whole suite dead in 532ms.
  //     🚨 The first tripwire (module-body assignment, not hoisted) did NOT trip on this
  //     same mutation: the library had already bound the real fetch at import time and
  //     downloaded 560MB straight through it (77s run, cache purged afterwards). The
  //     hoisted form is the load-bearing difference — see this file's header.
  it("embeds from the vendored path with the network tripwire armed", async () => {
    const v = await embedder.embedPassage("offline probe");
    expect(v).toHaveLength(1024);
  }, 60_000);

  it("pins the vendored identity: model dir name carries the revision hash", () => {
    expect(MODEL_DIR_NAME).toBe(`multilingual-e5-large@${MODEL_REVISION}`);
    expect(MODEL_REVISION).toMatch(/^[0-9a-f]{40}$/);
  });

  // P5. A missing vendored model must die NAMING THE FIX, before any loader runs —
  //     never a silent reach for the network (which the tripwire would catch anyway;
  //     this pin is about the error being actionable). mutation, RUN ✅ 2026-08-19:
  //     assertVendored() call deleted from createEmbedder -> AssertionError: expected
  //     [Function] to throw error matching /scripts\/fetch-embedding-model\.sh/ but got
  //     '`local_files_only=true` or `env.allowRemoteModels=false` and file was not found
  //     locally at "…/kb-no-model-…/config.json"' — still offline (the env pin held),
  //     but internals instead of an instruction. Restored, green.
  it("a missing vendored model names scripts/fetch-embedding-model.sh", async () => {
    const empty = mkdtempSync(join(tmpdir(), "kb-no-model-"));
    try {
      await expect(createEmbedder({ modelsRoot: empty })).rejects.toThrow(
        /scripts\/fetch-embedding-model\.sh/,
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
      // Re-arm the good embedder's module state for any test that follows.
      embedder = await createEmbedder();
    }
  }, 180_000);
});
