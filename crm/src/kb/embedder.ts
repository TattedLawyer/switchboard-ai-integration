/**
 * The LOCAL embedder — vendored weights, offline-pinned, prefix-asymmetric (plan C6).
 *
 * WHY LOCAL. Not cost (hosted is cents): RA 10173 accountability for transfers abroad —
 * the broker's business knowledge must not leave her deployment — plus deprecation
 * control. So the model is VENDORED (scripts/fetch-embedding-model.sh, verified against
 * the committed vendor/models/MANIFEST.sha256), remote loading is disabled AT MODULE
 * LOAD below, and the whole posture is pinned by test with a fetch tripwire
 * (crm/test/kb-embedder.test.ts). A hosted embedder, if ever wanted, sits behind this
 * same interface as an explicit opt-in — never as a fallback this module reaches for.
 *
 * WHICH MODEL. intfloat/multilingual-e5-large (via Xenova's ONNX export, q8): 1024
 * dimensions — the arity migration 023 pins in the schema — and MULTILINGUAL, because
 * the deployment is the Philippines and entries will be English/Tagalog/Taglish; an
 * English-only model would silently rank her Tagalog listings as noise. The alternate
 * considered was BAAI/bge-m3 (also 1024-dim, longer window but ~4x the weight size and
 * no prefix discipline to pin); e5-large is the plan's recommendation and quality is to
 * be settled BY MEASUREMENT at C6 proper, not re-litigated here.
 *
 * 🚨 THE PREFIX ASYMMETRY IS THE MODEL'S CONTRACT, NOT A STYLE. e5 was trained with
 * "query: " on questions and "passage: " on stored text; omitting or swapping them DOES
 * NOT ERROR — it silently degrades retrieval. Hence two functions and no raw embed():
 * a call site cannot forget a prefix it never had to supply. Pinned by test: the two
 * functions produce DIFFERENT vectors for identical input.
 *
 * 🚨 CONSTRUCTION, NOT FIRST CALL (call-transport.ts doctrine: "it throws at
 * CONSTRUCTION, not per call"). `createEmbedder()` loads the ~560MB model eagerly and is
 * meant to run ONCE at process start; a lazy per-call load would put a multi-second
 * stall into a live phone call later, and a missing model dies at boot — loudly, naming
 * the fix — instead of consuming work it cannot finish.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AutoTokenizer,
  env,
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";
import { EMBED_DIM } from "./dimensions.js";

export const MODEL_NAME = "multilingual-e5-large";
/** The upstream REVISION HASH (never a tag — tags move, a commit cannot), pinned in
 *  lockstep with scripts/fetch-embedding-model.sh and vendor/models/MANIFEST.sha256. */
export const MODEL_REVISION = "00fc3aeb3dbb95842de2ac1961d33c6319acf57b";
export const MODEL_DIR_NAME = `${MODEL_NAME}@${MODEL_REVISION}`;

/** e5's asymmetric prefixes — the model card's exact strings, trailing space included. */
export const QUERY_PREFIX = "query: ";
export const PASSAGE_PREFIX = "passage: ";

/**
 * The model's sequence window, in TOKENS (XLM-RoBERTa positions: 514 minus BOS/EOS).
 * 🚨 Transformers.js truncates SILENTLY at this length — half a listing vectorised as if
 * it were whole — so this module REFUSES over-window input instead (the chunker's job is
 * to never produce any), and length is always measured with the REAL tokenizer, never by
 * character count.
 */
export const MAX_SEQ_TOKENS = 512;

/** Weights + tokenizer live under `<repo>/vendor/models/<name>@<revision>/`. This file
 *  compiles to crm/dist/kb/, same depth as crm/src/kb/, so three ups reach the repo. */
const DEFAULT_MODELS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "vendor", "models");

// ── OFFLINE PINNING, AT MODULE LOAD, BEFORE ANY PIPELINE EXISTS ─────────────────────────
// Both lines run when this module is first imported, so no code path — not even a bug in
// this file — can construct a loader that consults the hub first.
//
// 🚨 MEASURED QUIRK, do not "simplify" the absolute-path loading below away: the
// vendored directory name carries "@<revision>", and Transformers.js only consults
// `env.localModelPath` for ids matching its REPO_ID_REGEX (`[\w\-.]` — no "@";
// transformers.node.mjs:5961, :6507 in 4.2.0). A relative id with "@" would resolve
// against the process CWD and miss. So loaders receive the ABSOLUTE vendored path
// (which the library uses verbatim), while these env pins stay as the global gate:
// allowRemoteModels=false makes any hub reach a hard error no matter what a loader does.
env.allowRemoteModels = false;
env.localModelPath = DEFAULT_MODELS_ROOT;

const REQUIRED_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/model_quantized.onnx",
] as const;

export interface EmbedderOptions {
  /** TEST-ONLY seam (P5's missing-model pin). Production always uses the repo default. */
  modelsRoot?: string;
}

export interface Embedder {
  /** Embed a QUESTION about to search the store. Never for stored text. */
  embedQuery(text: string): Promise<number[]>;
  /** Embed a CHUNK being stored. Never for questions. */
  embedPassage(text: string): Promise<number[]>;
  /** Token count exactly as the model will see it (real tokenizer, specials included). */
  countTokens(text: string): number;
}

/** Dies naming the fix — never a silent reach for the network (which module-load pinning
 *  forbids anyway; this guard exists so the operator reads an instruction, not a stack). */
function assertVendored(modelsRoot: string): void {
  const dir = join(modelsRoot, MODEL_DIR_NAME);
  const missing = REQUIRED_FILES.filter((f) => !existsSync(join(dir, f)));
  if (missing.length > 0) {
    throw new Error(
      `kb embedder: vendored model not found at ${dir} (missing: ${missing.join(", ")}). ` +
        `The embedding model runs LOCALLY and is never fetched at runtime (RA 10173) — ` +
        `run scripts/fetch-embedding-model.sh to download and verify it against the ` +
        `committed manifest.`,
    );
  }
}

/**
 * Loads ONLY the tokenizer (~17MB, sub-second) — for the chunker and its tests, which
 * need exact token counts without paying for the 560MB weights.
 */
export async function loadKbTokenizer(modelsRoot?: string): Promise<(text: string) => number> {
  const root = modelsRoot ?? DEFAULT_MODELS_ROOT;
  assertVendored(root);
  env.localModelPath = root;
  const tokenizer = await AutoTokenizer.from_pretrained(join(root, MODEL_DIR_NAME));
  return (text: string) => tokenizer.encode(text).length;
}

/**
 * The one construction the process performs at start. Eager: tokenizer and ONNX session
 * are fully loaded before this resolves, so the first embed is as fast as the thousandth
 * and a broken vendoring fails the boot, not a call.
 */
export async function createEmbedder(options: EmbedderOptions = {}): Promise<Embedder> {
  const root = options.modelsRoot ?? DEFAULT_MODELS_ROOT;
  assertVendored(root);
  env.localModelPath = root;

  // dtype pinned EXPLICITLY to q8 → onnx/model_quantized.onnx, the file the manifest
  // hashes. Left implicit, a library upgrade could silently prefer a different weight
  // file and the manifest would be guarding the wrong bytes.
  const extractor: FeatureExtractionPipeline = await pipeline(
    "feature-extraction",
    join(root, MODEL_DIR_NAME), // absolute — see the REPO_ID_REGEX note above
    { dtype: "q8" },
  );
  const tokenizer = extractor.tokenizer;
  const countTokens = (text: string): number => tokenizer.encode(text).length;

  async function embed(prefixed: string): Promise<number[]> {
    const tokens = countTokens(prefixed);
    if (tokens > MAX_SEQ_TOKENS) {
      throw new Error(
        `kb embedder: input is ${tokens} tokens; the window is ${MAX_SEQ_TOKENS} and the ` +
          `runtime would truncate SILENTLY — refuse instead. Chunk with kb/chunker.ts ` +
          `before embedding.`,
      );
    }
    // e5's pooling contract: average pool, L2-normalize — what pgvector's cosine
    // operators (and the store's distance semantics) assume.
    const out = await extractor(prefixed, { pooling: "mean", normalize: true });
    const data = Array.from(out.data as Float32Array);
    if (data.length !== EMBED_DIM) {
      throw new Error(
        `kb embedder: model returned ${data.length} dimensions, not the pinned ` +
          `${EMBED_DIM} — the vendored weights are not the reviewed model.`,
      );
    }
    return data;
  }

  return {
    embedQuery: (text) => embed(QUERY_PREFIX + text),
    embedPassage: (text) => embed(PASSAGE_PREFIX + text),
    countTokens,
  };
}
