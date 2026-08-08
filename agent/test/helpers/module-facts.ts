// AST facts about a TypeScript module, for the A1 writer-boundary sweep.
//
// WHY NOT REGEXES. The first version of the sweep matched `new pg.Pool`,
// `process.env.NAME` and `^import pg from "pg";`. A reviewer put a full-privilege
// writable pool with literal INSERT SQL inside `agent/src/host/` and all 84 agent tests
// stayed green — using no trickery whatsoever:
//
//     import { Pool } from "pg";                       // named import, not `pg.Pool`
//     const url = process.env["WRITER_DATABASE_URL"];  // bracket, not dot
//     export const writerPool = new Pool({ connectionString: url });
//
// Neither of those is indirection. They are what a well-meaning implementer writes on a
// Tuesday. The lesson is not "add the two spellings I now know about": a source-text
// assertion only ever enumerates the spellings its author thought of, and the whole point
// of this pin is to bind an implementer who has not read it. So the mechanism changes.
//
// THE MECHANISM. TypeScript's own parser — already a devDependency, no new tooling, no
// lint config to drift — produces the facts, and the assertions are about *bindings and
// module specifiers*, not about text. Three properties make this hard to evade rather
// than merely harder:
//
//   1. **The module specifier is the invariant a second pool cannot avoid.** Whatever the
//      import form, whatever the credential source (environment, file, hardcoded), code
//      that speaks to Postgres must obtain the driver from somewhere. Every mechanism for
//      that — static import, namespace import, named import, `export … from`,
//      `import()`, `require()`, `import x = require()` — names the module, and all of
//      them are collected here.
//   2. **Anything the parser cannot resolve statically is itself a violation.** A computed
//      module specifier or a computed `process.env` key does not slip through as "no
//      finding"; it is reported as `opaque` and the test reds on it. That inverts the
//      usual failure direction of static analysis, where cleverness buys silence.
//   3. **`process.env` is analysed as an OBJECT, not as a string.** Dot access, bracket
//      access with a literal, and destructuring all yield keys; aliasing the object,
//      spreading it, destructuring a rest element, or a computed key all yield `opaque`.
//
// Its limit, stated rather than implied: this is still a static control, and it only sees
// code under `agent/src/**`. It cannot see a transitive npm dependency opening its own
// connection, and it cannot see code that does not exist at build time. That is why it is
// paired with a RUNTIME control in `test/fixtures/boot-propose.ts`, which observes every
// connection the process actually opens regardless of how it was spelled. Static covers
// dormant code; runtime covers executed code. Neither alone is the pin.
import ts from "typescript";

export interface EnvAccess {
  /** A statically determinable key, or null when the access was not resolvable. */
  key: string | null;
  /** How it was written, for the failure message. */
  form: string;
}

export interface ModuleFacts {
  rel: string;
  /** Every module specifier referenced by ANY mechanism, deduplicated. */
  specifiers: string[];
  /** Local identifiers bound to the `pg` module, by any import form. */
  pgBindings: string[];
  /** Every `process.env` access, resolved or not. */
  envAccesses: EnvAccess[];
  /** Constructions of a class obtained from `pg`, with the source text of the argument. */
  poolConstructions: { form: string; argText: string }[];
  /**
   * Values this module EXPORTS that derive from a driver binding.
   *
   * BYPASS-C: the entrypoints are exempt from "no driver binding here" and "no pool here",
   * and nothing constrained what an exempted file hands OUT. One line —
   * `export const PoolCtor = pg.Pool;` — and any ordinary module could
   * `import { PoolCtor } from "./run-propose.js"` and construct a full-privilege pool: the
   * consumer binds no driver, so its own facts stay empty and every rule passes on a file
   * doing exactly the thing the pin forbids. Every previous round attacked a file smuggling
   * the driver IN; this is the exemption laundering it OUT.
   */
  exportedDriverValues: string[];
  /**
   * Things the parser could not resolve. NON-EMPTY IS A VIOLATION — a computed specifier
   * or a computed env key defeats every assertion built on the facts above, so it must
   * fail loudly rather than analyse to nothing.
   */
  opaque: string[];
}

const isProcessEnv = (node: ts.Node): boolean =>
  ts.isPropertyAccessExpression(node) &&
  node.name.text === "env" &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === "process";

/** JS and TS parse through the same parser; the kind only has to be right enough that JSX
 *  and TS syntax are each accepted where they are legal. `.mjs`/`.cjs`/`.js` are runnable
 *  by Node with no build step, which is exactly why they must be analysed (BYPASS-B). */
function scriptKindFor(rel: string): ts.ScriptKind {
  if (rel.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (rel.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(rel)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function analyzeModule(rel: string, source: string): ModuleFacts {
  const sf = ts.createSourceFile(rel, source, ts.ScriptTarget.ES2022, true, scriptKindFor(rel));
  const facts: ModuleFacts = {
    rel,
    specifiers: [],
    pgBindings: [],
    envAccesses: [],
    poolConstructions: [],
    exportedDriverValues: [],
    opaque: [],
  };
  const text = (n: ts.Node): string => n.getText(sf).replace(/\s+/g, " ").slice(0, 120);

  /** Records a module specifier and, when it is `pg`, the local names it binds. */
  // BYPASS-A: `../../../node_modules/pg/lib/index.js` is a driver import wearing a path.
  // `/^pg(\/|$)/` never matched it, so no binding was recorded and every downstream rule
  // was evaluating an empty fact set. Any specifier that reaches a package directory —
  // however it is spelled — names that package.
  const DRIVER_PACKAGE = /(?:^|\/)(?:node_modules\/)?(pg|pg-pool|pg-native|postgres|knex|sequelize|drizzle-orm)(?:\/|$)/;
  const record = (spec: string, binds: string[]): void => {
    if (!facts.specifiers.includes(spec)) facts.specifiers.push(spec);
    if (DRIVER_PACKAGE.test(spec)) {
      for (const b of binds) if (!facts.pgBindings.includes(b)) facts.pgBindings.push(b);
    }
    // Reaching into node_modules by path at all defeats the module whitelist, whatever the
    // package is. It is never legitimate here, so it is reported on its own terms rather
    // than depending on the package list above being complete.
    if (/(^|\/)node_modules(\/|$)/.test(spec)) {
      facts.opaque.push(`specifier reaches into node_modules by path: ${spec}`);
    }
  };

  const visit = (node: ts.Node): void => {
    // ── module specifiers, every form ────────────────────────────────────────────────
    if (ts.isImportDeclaration(node)) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) {
        facts.opaque.push(`non-literal import specifier: ${text(node)}`);
      } else {
        const binds: string[] = [];
        const clause = node.importClause;
        // A TYPE-ONLY import binds nothing at runtime and cannot construct anything, so it
        // is recorded as a specifier but never as a pg binding. That distinction is why
        // report.ts may hold `import type pg from "pg"` without being a pool site.
        const typeOnly = clause?.isTypeOnly === true;
        if (clause && !typeOnly) {
          if (clause.name) binds.push(clause.name.text);
          const nb = clause.namedBindings;
          if (nb && ts.isNamespaceImport(nb)) binds.push(nb.name.text);
          if (nb && ts.isNamedImports(nb)) {
            for (const el of nb.elements) if (!el.isTypeOnly) binds.push(el.name.text);
          }
        }
        record(node.moduleSpecifier.text, binds);
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) {
        facts.opaque.push(`non-literal re-export specifier: ${text(node)}`);
      } else {
        // A re-export leaks the binding to every importer of THIS module — a barrel file
        // is a pool site by proxy, so it counts as one.
        record(node.moduleSpecifier.text, ["<re-export>"]);
      }
    }
    if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (ts.isExternalModuleReference(ref)) {
        if (ts.isStringLiteral(ref.expression)) record(ref.expression.text, [node.name.text]);
        else facts.opaque.push(`non-literal import= specifier: ${text(node)}`);
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      // Both spellings: `createRequire(...)` from a named import, and `mod.createRequire(...)`
      // from a namespace one. A caller who aliases the import defeats this check by name —
      // and is caught anyway by the module whitelist, since `node:module` is not on it.
      // Two independent layers, which is the point of having a whitelist at all.
      const isCreateRequire =
        (ts.isIdentifier(callee) && callee.text === "createRequire") ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === "createRequire");
      if (isCreateRequire) {
        facts.opaque.push(`createRequire escapes specifier analysis: ${text(node)}`);
      }
      if (isDynamicImport || isRequire) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          // A dynamic import binds nothing lexically, but whatever it returns is the
          // module — so it is a pg reference if it names pg.
          record(arg.text, ["<dynamic>"]);
        } else {
          facts.opaque.push(`non-literal ${isRequire ? "require" : "import()"}: ${text(node)}`);
        }
      }
    }

    // ── process.env, analysed as an object ───────────────────────────────────────────
    if (isProcessEnv(node)) {
      const parent = node.parent;
      if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        facts.envAccesses.push({ key: parent.name.text, form: `process.env.${parent.name.text}` });
      } else if (parent && ts.isElementAccessExpression(parent) && parent.expression === node) {
        const arg = parent.argumentExpression;
        if (arg && ts.isStringLiteralLike(arg)) {
          facts.envAccesses.push({ key: arg.text, form: `process.env["${arg.text}"]` });
        } else {
          facts.envAccesses.push({ key: null, form: text(parent) });
          facts.opaque.push(`computed process.env key: ${text(parent)}`);
        }
      } else if (
        parent &&
        ts.isVariableDeclaration(parent) &&
        parent.initializer === node &&
        ts.isObjectBindingPattern(parent.name)
      ) {
        for (const el of parent.name.elements) {
          if (el.dotDotDotToken) {
            facts.envAccesses.push({ key: null, form: text(parent) });
            facts.opaque.push(`rest-destructured process.env: ${text(parent)}`);
            continue;
          }
          const nameNode = el.propertyName ?? el.name;
          if (ts.isIdentifier(nameNode) || ts.isStringLiteralLike(nameNode)) {
            facts.envAccesses.push({
              key: nameNode.text,
              form: `const { ${nameNode.text} } = process.env`,
            });
          } else {
            facts.envAccesses.push({ key: null, form: text(parent) });
            facts.opaque.push(`computed destructuring of process.env: ${text(parent)}`);
          }
        }
      } else {
        // Aliased, spread, passed as an argument, Object.keys'd — the object escaped, and
        // every key in it is now reachable by a name this analysis cannot see.
        facts.envAccesses.push({ key: null, form: text(parent ?? node) });
        facts.opaque.push(`process.env escapes static analysis: ${text(parent ?? node)}`);
      }
    }

    // ── construction of anything obtained from pg ────────────────────────────────────
    if (ts.isNewExpression(node)) {
      const e = node.expression;
      const argText = node.arguments?.map((a) => text(a)).join(", ") ?? "";
      if (ts.isIdentifier(e) && facts.pgBindings.includes(e.text)) {
        facts.poolConstructions.push({ form: `new ${e.text}(…)`, argText });
      } else if (
        ts.isPropertyAccessExpression(e) &&
        ts.isIdentifier(e.expression) &&
        facts.pgBindings.includes(e.expression.text)
      ) {
        facts.poolConstructions.push({
          form: `new ${e.expression.text}.${e.name.text}(…)`,
          argText,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  // Two passes: bindings can be introduced by an import that appears after a use in the
  // AST walk order of some constructs, and a missed binding would under-report.
  ts.forEachChild(sf, visit);
  facts.poolConstructions = [];
  ts.forEachChild(sf, (n) => {
    const collect = (node: ts.Node): void => {
      if (ts.isNewExpression(node)) {
        const argText = node.arguments?.map((a) => text(a)).join(", ") ?? "";
        // The LEFTMOST identifier of the chain, so `new pg.native.Client(…)` is recognised
        // as a pg construction. The previous version only unwrapped ONE property access, so
        // any two-hop path off the driver namespace escaped rule 4's argument check
        // entirely — a grant nothing had checked, found by probing what the corpus permits
        // rather than what it forbids.
        let root: ts.Node = node.expression;
        while (ts.isPropertyAccessExpression(root)) root = root.expression;
        if (ts.isIdentifier(root) && facts.pgBindings.includes(root.text)) {
          facts.poolConstructions.push({ form: `new ${text(node.expression)}(…)`, argText });
        }
      }
      ts.forEachChild(node, collect);
    };
    collect(n);
  });

  // ── what this module hands OUT (BYPASS-C) ───────────────────────────────────────────
  // A fixpoint, because laundering can go through aliases: `const A = pg.Pool; const B = A;
  // export const C = B;`. Three rounds is far past what any real chain needs, and the cost
  // of an extra round is nothing next to the cost of missing one.
  const derived = new Set<string>(facts.pgBindings);
  const referencesDerived = (node: ts.Node): boolean => {
    let hit = false;
    const scan = (n: ts.Node): void => {
      if (hit) return;
      if (ts.isIdentifier(n) && derived.has(n.text)) hit = true;
      else ts.forEachChild(n, scan);
    };
    ts.forEachChild(node, scan);
    return hit;
  };
  const declaredNames = (stmt: ts.Node): string[] => {
    if (ts.isVariableStatement(stmt)) {
      return stmt.declarationList.declarations
        .filter((d) => ts.isIdentifier(d.name))
        .map((d) => (d.name as ts.Identifier).text);
    }
    if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name) {
      return [stmt.name.text];
    }
    return [];
  };
  for (let round = 0; round < 3; round++) {
    for (const stmt of sf.statements) {
      if (referencesDerived(stmt)) for (const nm of declaredNames(stmt)) derived.add(nm);
    }
  }
  const isExported = (stmt: ts.Node): boolean =>
    ts.canHaveModifiers(stmt) &&
    (ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  /**
   * An exported FUNCTION that touches the driver is allowed exactly when it proves
   * statically that it hands nothing back: an explicit `void` or `Promise<void>` return
   * annotation. `run-propose.ts`'s `main(): Promise<void>` builds the read-only pool, uses
   * it and ends it — legitimate, and the annotation is what makes that checkable instead
   * of a judgement call about the body.
   *
   * A missing annotation is a VIOLATION, not a pass. `export function getPool() { return
   * new pg.Pool(…); }` is a factory laundering the pool exactly as effectively as exporting
   * the class, and inference would let it through silently. Requiring the annotation makes
   * the author state the property the rule depends on.
   */
  const returnsNothing = (stmt: ts.Node): boolean => {
    if (!ts.isFunctionDeclaration(stmt)) return false;
    const t = stmt.type;
    if (!t) return false; // unannotated: cannot be shown to hand nothing back
    const txt = t.getText(sf).replace(/\s+/g, "");
    return txt === "void" || txt === "Promise<void>";
  };

  for (const stmt of sf.statements) {
    if (isExported(stmt)) {
      if (returnsNothing(stmt)) continue;
      for (const nm of declaredNames(stmt)) {
        if (derived.has(nm)) facts.exportedDriverValues.push(nm);
      }
    }
    // `export { PoolCtor }` — a local binding exported separately from its declaration.
    if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause) {
      if (ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          const local = (el.propertyName ?? el.name).text;
          if (derived.has(local)) facts.exportedDriverValues.push(local);
        }
      }
    }
    // `export default pg.Pool`
    if (ts.isExportAssignment(stmt) && referencesDerived(stmt)) {
      facts.exportedDriverValues.push("default");
    }
  }

  return facts;
}

// ── the writer-boundary predicate itself ───────────────────────────────────────────────
//
// One function, used by TWO callers: the sweep over the real `agent/src/**`
// (writer-boundary.test.ts) and the bypass corpus (module-facts.test.ts). That sharing is
// deliberate. A corpus that ran its own copy of the rules would prove the corpus is caught
// by rules nobody ships; this way the corpus proves the SHIPPED predicate catches it, and
// weakening the predicate to make the real sweep pass immediately reds the corpus.

import { candidateTargets, resolveRelative } from "./writer-boundary-config.js";

export interface WriterBoundaryConfig {
  /** Files permitted to bind the database driver and construct a pool. */
  poolEntrypoints: readonly string[];
  /** Every non-relative module `agent/src/**` may reference, by any mechanism. */
  allowedExternalModules: readonly string[];
  /** Env keys matching this may only ever be the one allowed name below. */
  credentialShaped: RegExp;
  allowedCredentialKey: string;
  /** Required substring of a pool's constructor argument. */
  requiredConnectionExpression: string;
  /**
   * Connection fields an entrypoint's pool argument may NOT set. The entrypoints are
   * exempt from "no pool here", so without this the exemption is a hole: a pool built as
   * `{ connectionString: agentConnectionString(), user: "switchboard", password: … }`
   * satisfies the required-substring rule while connecting as a different role, since
   * node-postgres lets discrete fields override the URL.
   */
  forbiddenConnectionFields: readonly string[];
}

export const WRITER_BOUNDARY_DEFAULTS = {
  credentialShaped: /DATABASE_URL|DB_PASSWORD|DB_URL|^PG|POSTGRES_/,
  allowedCredentialKey: "AGENT_DATABASE_URL",
  requiredConnectionExpression: "connectionString: agentConnectionString()",
  forbiddenConnectionFields: ["user:", "password:", "host:", "port:", "database:"],
} as const;

/** Every way the modules given violate the writer boundary. Empty means contained. */
export function writerBoundaryViolations(
  modules: readonly ModuleFacts[],
  config: WriterBoundaryConfig,
  /** Files the collector refused to read. NON-EMPTY IS A VIOLATION — see BYPASS-B. */
  uncovered: readonly string[] = [],
): string[] {
  const out: string[] = [];
  const swept = new Set(modules.map((m) => m.rel));
  for (const u of uncovered) {
    out.push(`UNCOVERED: ${u} — the sweep cannot read it, so it is not contained`);
  }
  for (const f of modules) {
    // 1. Unresolvable constructs are the finding, not an absence of one.
    for (const o of f.opaque) out.push(`${f.rel}: ${o}`);

    // 2. Specifiers. A relative one used to be waved through as "internal" — the exemption
    //    BYPASS-A walked through, because `../../../node_modules/pg/lib/index.js` is
    //    relative and is not internal at all. Every relative specifier must now resolve to
    //    a file the sweep actually read; everything else must be on the whitelist.
    for (const spec of f.specifiers) {
      if (spec.startsWith(".")) {
        const resolved = resolveRelative(f.rel, spec);
        if (resolved === null) {
          out.push(`${f.rel}: relative specifier "${spec}" escapes the swept tree`);
        } else if (!candidateTargets(resolved).some((c) => swept.has(c))) {
          out.push(
            `${f.rel}: relative specifier "${spec}" resolves to "${resolved}", which the sweep does not cover`,
          );
        }
        continue;
      }
      if (!config.allowedExternalModules.includes(spec)) {
        out.push(`${f.rel}: references non-whitelisted module "${spec}"`);
      }
    }

    const isEntrypoint = config.poolEntrypoints.includes(f.rel);

    // 3. The driver binding, in any import form — including a re-export, which makes every
    //    importer of that file a pool site by proxy.
    if (f.pgBindings.includes("<re-export>")) {
      out.push(`${f.rel}: re-exports a database module, laundering the binding`);
    }
    // BYPASS-C. The entrypoints are exempt from holding the driver; they are NOT exempt
    // from handing it out. Without this, the exemption is a hole exactly the width of one
    // `export const PoolCtor = pg.Pool;` — and that line is what a well-meaning "share the
    // pool so we stop constructing two" refactor produces. It reads as innocent in review,
    // which is why it needs a rule rather than a convention.
    for (const name of f.exportedDriverValues) {
      out.push(
        `${f.rel}: exports "${name}", which derives from the database driver — an ` +
          `exempted file may hold the driver, never hand it out`,
      );
    }
    if (f.pgBindings.length > 0 && !isEntrypoint) {
      out.push(`${f.rel}: binds the database driver (${f.pgBindings.join(", ")})`);
    }

    // 4. Pool construction, and what it is constructed from.
    for (const c of f.poolConstructions) {
      if (!isEntrypoint) {
        out.push(`${f.rel}: constructs a database pool (${c.form})`);
      } else if (!c.argText.includes(config.requiredConnectionExpression)) {
        out.push(`${f.rel}: ${c.form} is not built from ${config.requiredConnectionExpression}`);
      } else {
        for (const field of config.forbiddenConnectionFields) {
          if (c.argText.includes(field)) {
            out.push(
              `${f.rel}: ${c.form} overrides connection field "${field}" — discrete fields ` +
                `beat the URL in node-postgres, so this can connect as another role`,
            );
          }
        }
      }
    }

    // 5. Credential-shaped environment keys.
    for (const a of f.envAccesses) {
      if (a.key === null) continue; // already reported as opaque above
      if (!config.credentialShaped.test(a.key)) continue;
      if (a.key !== config.allowedCredentialKey) {
        out.push(`${f.rel}: reads credential-shaped ${a.form}`);
      }
    }
  }
  return out;
}
