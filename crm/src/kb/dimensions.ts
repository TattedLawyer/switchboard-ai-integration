/**
 * The pinned embedding dimension — 1024, everywhere, or nowhere.
 *
 * One constant in one dependency-free module, because THREE things must agree on it and
 * two of them must not import each other: migration 023's `vector(1024)` column (the
 * mechanical enforcement, pinned in crm/test/migration-023.test.ts), the store's
 * pre-flight arity check (kb/store.ts, which must stay light enough to import anywhere),
 * and the local embedder's output contract (kb/embedder.ts, which drags the ONNX runtime
 * with it and must NOT be imported just to learn a number).
 *
 * 🚨 The dimension is a SCHEMA fact, not a model preference: changing it means a new
 * migration, a re-embed of every stored chunk, and a deliberate model decision — never a
 * constant edit. The recorded reason for 1024 (corrected from the plan text): pgvector's
 * `vector` TYPE goes to 16,000 dims; the HNSW INDEX caps at 2,000; the chosen
 * multilingual model emits 1024, which clears the cap that actually binds.
 */
export const EMBED_DIM = 1024;
