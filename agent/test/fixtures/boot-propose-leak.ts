// A DELIBERATELY LEAKY variant of boot-propose.ts, used to prove the runtime control can
// actually fire. Without this, "every connection was switchboard_agent" is an assertion
// that has never been observed failing — and this repo's recurring defect is exactly the
// assertion that cannot fail.
//
// It models the case the AST sweep provably CANNOT see: a connection opened by code the
// static analysis does not read (here, a fixture standing in for a transitive dependency),
// through a variable whose name is not credential-shaped, so the environment whitelist
// passes it too. Only the prototype patch catches it.
// Child harness for the A1 boot pin. Runs the REAL proposal path in a process whose
// environment the test controls completely, and reports on THREE things the parent
// asserts: which credential-shaped variables it can see, which database roles it actually
// connected as, and — when the path fails — the failure its own code classified.
//
// 1. THE ENVIRONMENT WHITELIST. A whitelist on purpose. An earlier draft asserted
//    `process.env.DATABASE_URL === undefined`, which names a VARIABLE, not a property: an
//    implementer wanting a writer pool does not have to touch DATABASE_URL, they add
//    WRITER_DATABASE_URL, and a denial of one name stays green. Enumerating every
//    credential-shaped key and asserting the set EQUALS the one allowed name closes that.
//    `^PG` is in the pattern because libpq takes credentials through channels that contain
//    no URL at all — PGPASSFILE, PGSERVICE, PGSERVICEFILE, PGHOST, PGSSLKEY — so a pool
//    could authenticate with every URL-shaped variable absent.
//
// 2. THE RUNTIME ROLE OBSERVATION, and this is the part no source-text or AST control can
//    give. The static sweep in writer-boundary.test.ts reasons about code that exists at
//    build time under `agent/src/**`. It cannot see a transitive npm dependency opening a
//    connection, and it cannot see code generated at runtime. Patching
//    `pg.Client.prototype.connect` observes EVERY connection this process opens, whatever
//    module opened it and however that module spelled its import — because Pool constructs
//    Clients, and every Client shares this prototype. Static covers dormant code; runtime
//    covers executed code. The pin is the pair, and neither half is claimed to be the
//    whole thing.
//
// 3. THE CLASSIFIED FAILURE. `await main()` used to be bare, so a rejection produced
//    Node's unhandled-rejection dump — and the parent's assertion that stderr contained
//    "401" passed with propose.ts's entire non-2xx branch deleted, because Node prints the
//    whole error object including a status the code never looked at. Failures are caught
//    and printed as a structured line built from a field the code assigned.
import pg from "pg";
import { ProposalNotRecordedError } from "../../src/host/propose.js";
import { main } from "../../src/host/run-propose.js";
import { openLeakConnection } from "./leak-connection.js";

const CREDENTIAL_SHAPED = /DATABASE_URL|DB_PASSWORD|DB_URL|^PG|POSTGRES_/;

const present = Object.keys(process.env).filter((k) => CREDENTIAL_SHAPED.test(k)).sort();
const allowed = ["AGENT_DATABASE_URL"];

if (JSON.stringify(present) !== JSON.stringify(allowed)) {
  console.error(
    `CREDENTIAL_LEAK: the agent process can see credential-shaped variables ` +
      `${JSON.stringify(present)}; only ${JSON.stringify(allowed)} is permitted.`,
  );
  process.exit(2);
}
console.log(`ENV_WHITELIST_OK ${JSON.stringify(present)}`);

// ── runtime observation of every connection this process opens ─────────────────────────
const observedRoles = new Set<string>();
const realConnect = pg.Client.prototype.connect;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- prototype patch, by design
(pg.Client.prototype as any).connect = function patched(this: pg.Client, ...args: unknown[]) {
  const params = (this as unknown as { connectionParameters?: { user?: string } })
    .connectionParameters;
  observedRoles.add(params?.user ?? "<unknown>");
  return (realConnect as (...a: unknown[]) => unknown).apply(this, args);
};

let failed = false;
await openLeakConnection(); // the thing neither static control can see

try {
  await main();
} catch (err) {
  failed = true;
  if (err instanceof ProposalNotRecordedError) {
    // Built from `kind`, which the code assigns — not from text the runtime might also
    // have emitted. This line is what the parent asserts on.
    console.error(`DOOR_REFUSED kind=${err.kind} status=${err.status ?? "none"}`);
  } else {
    console.error(`BOOT_FAILED ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Reported whether or not the proposal succeeded: a run that failed at the door still
// opened its database connection, and that connection's role is exactly what is under
// test here.
const roles = [...observedRoles].sort();
if (roles.some((r) => r !== "switchboard_agent")) {
  console.error(
    `CREDENTIAL_LEAK_RUNTIME: this process opened database connections as ` +
      `${JSON.stringify(roles)}; only ["switchboard_agent"] is permitted.`,
  );
  process.exit(3);
}
console.log(`DB_ROLES_OK ${JSON.stringify(roles)}`);

if (failed) process.exit(1);
console.log("PROPOSAL_PATH_OK");
