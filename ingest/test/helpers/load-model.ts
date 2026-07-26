import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// B2 (truth-in-claims): tests that exercise warehouse SQL load the REAL model text from
// disk and substitute {{ ref('x') }} with test fixtures — no hand-mirrored copies. A
// mirror synced by comment already drifted once undetected (ordering.test.ts carried
// `like 'company.%'` against the model's `= 'company.updated'` under a comment claiming
// to be "the exact" query — external audit 2026-07-25, F2). A CI diff would only DETECT
// drift, and can't work on deliberately non-identical mirrors; loading the real text
// makes drift structurally impossible.
const WAREHOUSE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../warehouse");

export function loadModel(relPath: string, refMap: Record<string, string> = {}): string {
  let sql = readFileSync(join(WAREHOUSE_DIR, relPath), "utf8");
  sql = sql.replace(/\{\{\s*config\([\s\S]*?\)\s*\}\}/g, "");
  sql = sql.replace(/\{\{\s*ref\('([^']+)'\)\s*\}\}/g, (_m, name: string) => {
    const target = refMap[name];
    if (!target) throw new Error(`loadModel: no refMap entry for ref('${name}') in ${relPath}`);
    return target;
  });
  const leftover = /\{\{[\s\S]*?\}\}/.exec(sql);
  if (leftover) throw new Error(`loadModel: unhandled jinja in ${relPath}: ${leftover[0]}`);
  return sql;
}
