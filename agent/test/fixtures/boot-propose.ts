// Child harness for the A1 boot pin. Runs the REAL proposal path in a process whose
// environment the test controls completely.
//
// The whitelist below is the load-bearing half, and it is a whitelist on purpose. The
// earlier draft of this pin asserted `process.env.DATABASE_URL === undefined` — which
// names a VARIABLE, not a property: an implementer wanting a writer pool in the agent host
// does not have to touch DATABASE_URL, they add WRITER_DATABASE_URL, and a denial of one
// name stays green while a full-privilege pool sits in agent/src/host/. Enumerating every
// credential-shaped key and asserting the set EQUALS the one allowed name closes that.
//
// Asserted from inside the child, before any work runs, so a harness that silently
// re-injected a credential could not make this pass hollowly.
import { main } from "../../src/host/run-propose.js";

const CREDENTIAL_SHAPED = /DATABASE_URL|DB_PASSWORD|DB_URL|PGPASSWORD|PGUSER|POSTGRES_PASSWORD/;

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

await main();
console.log("PROPOSAL_PATH_OK");
