// The project's dbt green criterion, as DATA rather than as prose.
//
// Since close F7 the CI fixture deliberately seeds one above-bound charge so the
// unlikely-value warn surface is proven to fire end-to-end in the BUILT warehouse
// (before that, `assert_amounts_plausible` passed vacuously on all-plausible amounts).
// `dbt build` therefore always reports WARN=1 — and dbt exits 0 on warnings, so the
// green criterion silently became "ERROR=0, WARN=1 naming assert_amounts_plausible".
//
// That is a masking hazard, not just a documentation gap: `assert_unusable_amounts_
// flagged` is also warn-severity (currently 0 rows). One unusable amount in a future
// fixture makes it 2 warnings, dbt still exits 0, and the NEW warn hides behind the
// expected one. Nothing asserted the warn count or identity.
//
// So the expected warn set is pinned here, exactly, and checked against dbt's own
// run_results.json artifact after every build. Any deviation in EITHER direction is a
// failure: a second warn-severity test firing (the masking case) AND the expected warn
// going missing (the fixture quietly stopping its demonstration, i.e. F7 decaying back
// to vacuous). Test severity/threshold config was rejected for this job — see the
// rationale on `assert_amounts_plausible` in warehouse/tests/.

/** The complete set of dbt nodes allowed to WARN on the CI fixture universe, mapped to
 *  the exact number of failing rows each is allowed to surface. Keyed by node NAME (the
 *  third segment of run_results' `unique_id`, which for singular tests carries a
 *  trailing checksum segment). Empty value semantics: any node not listed here must not
 *  warn at all. */
export const EXPECTED_DBT_WARNS: Readonly<Record<string, number>> = {
  // close F7's demonstration row: DEMO-CH-0001 at plausibleMax + 1, seeded by
  // scripts/ci-fixture.ts from NUMERIC_CONTRACT. Row identity is checked separately,
  // against the test's own stored failures — see scripts/verify-dbt-warns.ts.
  assert_amounts_plausible: 1,
};

type RunResult = { unique_id?: unknown; status?: unknown; failures?: unknown };

/** Node name from a run_results unique_id (`test.switchboard.<name>[.<checksum>]`). */
function nodeName(uniqueId: string): string {
  const parts = uniqueId.split(".");
  return parts.length >= 3 ? parts[2] : uniqueId;
}

/**
 * Checks a parsed run_results.json against the expected warn set.
 * Returns a list of human-readable failures — empty means the build matched the pinned
 * green criterion exactly. Never throws on malformed input; malformed IS a failure,
 * because a verifier that can't read the artifact must not report success.
 */
export function checkWarnSet(
  runResults: unknown,
  expected: Readonly<Record<string, number>> = EXPECTED_DBT_WARNS,
): string[] {
  const failures: string[] = [];
  if (typeof runResults !== "object" || runResults === null) {
    return ["run_results.json is not an object — nothing was verified"];
  }
  const doc = runResults as { results?: unknown; args?: unknown };

  // Staleness guard: this criterion is about what `dbt build` produced. A run_results
  // left behind by some other command (or a hand-run `dbt test -s one_model`) describes
  // a different node universe, and set-equality against it would be meaningless.
  const which = (doc.args as { which?: unknown } | undefined)?.which;
  if (which !== "build") {
    failures.push(`run_results is from \`dbt ${String(which)}\`, not \`dbt build\` — stale or partial artifact`);
  }

  const results = doc.results;
  if (!Array.isArray(results)) return [...failures, "run_results.results is not an array — nothing was verified"];
  // Vacuity guard: an empty results array would make every set comparison below pass.
  if (results.length === 0) return [...failures, "run_results.results is empty — nothing was verified"];

  const seen = new Map<string, number>();
  for (const r of results as RunResult[]) {
    const uid = typeof r.unique_id === "string" ? r.unique_id : "<no unique_id>";
    const status = typeof r.status === "string" ? r.status : "<no status>";
    if (status === "warn") {
      const n = typeof r.failures === "number" ? r.failures : Number.NaN;
      seen.set(nodeName(uid), n);
    } else if (status !== "pass" && status !== "success" && status !== "skipped") {
      // dbt build already exits non-zero on these; catching them here means the
      // verifier can never report "green" over a run that wasn't.
      failures.push(`${uid}: status ${status} (not pass/warn)`);
    }
  }

  for (const [name, count] of Object.entries(expected)) {
    if (!seen.has(name)) {
      failures.push(
        `expected WARN from ${name} (${count} row(s)) did not fire — the CI fixture has stopped demonstrating the warn surface (close F7)`,
      );
    } else if (seen.get(name) !== count) {
      failures.push(`${name}: expected ${count} warning row(s), got ${String(seen.get(name))}`);
    }
  }
  for (const [name, count] of seen) {
    if (!(name in expected)) {
      failures.push(
        `UNEXPECTED WARN: ${name} surfaced ${count} row(s) — a new warn-severity signal was hiding behind the expected one (dbt exits 0 on warnings)`,
      );
    }
  }
  return failures;
}

// ── PRE-3 (#19): where dbt actually wrote ────────────────────────────────────────────
//
// `verify-dbt-warns.ts` reads the stored-failures table dbt produced, so it must resolve
// its connection the way dbt does. dbt reads `warehouse/profiles.yml`, which is
// `DBT_HOST` / `DBT_PORT` / `DBT_USER` / `DBT_PASSWORD` / `DBT_DBNAME` with the defaults
// mirrored below; the gate was reading `DATABASE_URL`. In CI the two spell the same
// database, so the defect is invisible precisely where the script runs — and anywhere the
// app database and the warehouse database differ, the gate inspects a database dbt never
// touched and blames `store_failures`, which is a correct-shaped failure pointing at the
// wrong cause.
//
// Defaults here are profiles.yml's, quoted, and pinned in dbt-warn-contract.test.ts —
// including port 5433, whose two-contexts reasoning lives in profiles.yml itself. Note
// only the CONNECTION moves: the audit-schema literal (`public_dbt_test__audit`) stays a
// literal, because it is derived from profiles.yml's `schema: public` and is a fact of the
// repo rather than config.

export interface DbtEndpoint {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** The endpoint dbt itself would connect to, from the same variables profiles.yml reads. */
export function dbtEndpointFromEnv(env: NodeJS.ProcessEnv): DbtEndpoint {
  const rawPort = env.DBT_PORT;
  const port = rawPort === undefined || rawPort === "" ? 5433 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    // Same operator-surface form as ingest/src/config.ts: name the variable, echo the
    // rejected value, state what would be accepted. Never NaN into a connection.
    throw new Error(`invalid DBT_PORT "${rawPort}": must be an integer between 1 and 65535`);
  }
  return {
    host: env.DBT_HOST ?? "localhost",
    port,
    user: env.DBT_USER ?? "switchboard",
    password: env.DBT_PASSWORD ?? "switchboard",
    database: env.DBT_DBNAME ?? "switchboard",
  };
}

/** The app-side endpoint, for the comparison only — never for the query. */
export function databaseUrlEndpoint(
  env: NodeJS.ProcessEnv,
): { host: string; port: number; database: string } | null {
  const raw = env.DATABASE_URL;
  if (raw === undefined || raw === "") return null;
  try {
    const u = new URL(raw);
    return {
      host: u.hostname,
      port: u.port === "" ? 5432 : Number(u.port),
      database: decodeURIComponent(u.pathname.replace(/^\//, "")),
    };
  } catch {
    return null;
  }
}

/** `<database>@<host>:<port>` — the shape both halves of the failure message use. */
export function describeEndpoint(e: { host: string; port: number; database: string }): string {
  return `${e.database}@${e.host}:${e.port}`;
}

/**
 * The message for "the audit schema is not there". Names the MISMATCH when the two
 * endpoints differ — that is the real cause and the reader can act on it — and falls back
 * to the store_failures explanation only when they agree, which is the one case where
 * store_failures genuinely is the remaining suspect.
 */
export function auditSchemaMissingMessage(opts: {
  auditSchema: string;
  dbt: DbtEndpoint;
  appUrl: { host: string; port: number; database: string } | null;
  cause: string;
}): string {
  const dbtDesc = describeEndpoint(opts.dbt);
  const appDesc = opts.appUrl === null ? null : describeEndpoint(opts.appUrl);
  if (appDesc !== null && appDesc !== dbtDesc) {
    return (
      `cannot read ${opts.auditSchema}.assert_amounts_plausible — looked in ${dbtDesc} ` +
      `(resolved from DBT_HOST/DBT_PORT/DBT_DBNAME, the same variables warehouse/profiles.yml reads), ` +
      `while DATABASE_URL names ${appDesc}. If dbt built into ${appDesc}, point the DBT_* ` +
      `variables at it; the two must name the same database for this gate to mean anything. ` +
      `(${opts.cause})`
    );
  }
  return (
    `cannot read the stored failures of assert_amounts_plausible (${opts.auditSchema}) in ${dbtDesc} — ` +
    `store_failures must stay on for the identity check: ${opts.cause}`
  );
}
