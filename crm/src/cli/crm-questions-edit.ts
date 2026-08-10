// Operator CLI — publish a new version of her question list. Owner role (016 §I-3).
//
// Usage:
//   node --import tsx src/cli/crm-questions-edit.ts --tenant <uuid> \
//     --q budget:text:"What budget range are you working with?" \
//     --q timeline:text:"When are you hoping to move?"
//   node --import tsx src/cli/crm-questions-edit.ts --tenant <uuid> --show
//
// EDITING NEVER REWRITES. Every run publishes a NEW VERSION and retires the previous one,
// so an answer recorded in March still resolves to March's wording after a June edit. The
// KEY (`budget`) is yours to keep stable across versions — it is the cross-version join,
// and changing it silently orphans the history it was there to connect.
//
// Approved-but-not-yet-executed proposals are UNAFFECTED and will still ask the retired
// version. That is deliberate: she approved those exact words, and a retirement check in
// the executor would strand the whole approved queue on every edit.
import { getOwnerPool } from "../db.js";
import { publishQuestionSet, currentQuestionSet, type AnswerKind } from "../questions.js";

const KINDS = new Set(["text", "number", "yes_no", "date"]);

function args(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}` && process.argv[i + 1] !== undefined) {
      out.push(process.argv[i + 1]);
    }
  }
  return out;
}
const one = (name: string): string | undefined => args(name)[0];

async function main(): Promise<void> {
  const pool = getOwnerPool();
  try {
    const tenant = one("tenant");
    if (!tenant) {
      console.error("--tenant <uuid> is required");
      await pool.end();
      process.exit(1);
    }
    if (process.argv.includes("--show")) {
      const set = await currentQuestionSet(pool, tenant);
      if (!set) {
        console.log("no question set exists — no call can be proposed until one does");
      } else {
        console.log(`version ${set.version} (${set.id})`);
        for (const q of set.questions) {
          console.log(`  ${q.ordinal}. [${q.questionKey}/${q.answerKind}] ${q.promptText}`);
        }
      }
      await pool.end();
      process.exit(0);
    }

    const drafts = args("q").map((spec) => {
      const first = spec.indexOf(":");
      const second = spec.indexOf(":", first + 1);
      if (first === -1 || second === -1) {
        throw new Error(`--q must be key:kind:"prompt text" — got ${JSON.stringify(spec)}`);
      }
      const kind = spec.slice(first + 1, second);
      if (!KINDS.has(kind)) {
        throw new Error(`unknown answer kind ${JSON.stringify(kind)}; expected one of ${[...KINDS].join(", ")}`);
      }
      return {
        key: spec.slice(0, first),
        kind: kind as AnswerKind,
        prompt: spec.slice(second + 1),
      };
    });
    if (drafts.length === 0) {
      console.error('at least one --q key:kind:"prompt" is required');
      await pool.end();
      process.exit(1);
    }
    const r = await publishQuestionSet(pool, tenant, drafts);
    console.log(`published question set version ${r.version} (${r.setId})`);
    if (r.retiredSetId) {
      console.log(
        `retired ${r.retiredSetId} — its rows stay readable forever, because they are what ` +
          `every answer recorded against them means. Already-approved proposals still ask it.`,
      );
    }
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error("crm-questions-edit failed:", err instanceof Error ? err.message : err);
    await pool.end();
    process.exit(1);
  }
}

main();
