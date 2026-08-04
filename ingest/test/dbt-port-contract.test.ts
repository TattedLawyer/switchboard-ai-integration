// Every context that runs dbt states its OWN port, because the two contexts disagree.
//
// Postgres listens on 5432 inside the compose network and is PUBLISHED on 5433 to the
// host (`docker-compose.yml`: ports ["5433:5432"]). So:
//
//   - the `dbt` compose service talks to the container directly  → 5432
//   - CI's dbt step and a developer's `dbt build` talk to the host mapping → 5433
//
// There is no single default that is right for both, which is exactly why this keeps
// getting broken by a correct fix to the other side. Gate-H M7 moved profiles.yml's
// default from 5432 to 5433 — right for the host, and it fixed a real silent
// wrong-cluster build — but the compose service inherited that default and the chaos
// workflow's demo job died with `connection to server at "postgres" (172.18.0.2), port
// 5433 failed: Connection refused`. The default cannot be swept back either; that just
// re-breaks the host side.
//
// So the invariant is not "the port is N". It is: each context states its own port
// explicitly, and the default covers only the manual host run. That is what this pins.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoFile = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

const compose = repoFile("docker-compose.yml");
const profiles = repoFile("warehouse/profiles.yml");
const ci = repoFile(".github/workflows/ci.yml");

describe("dbt connection settings state the port appropriate to their context", () => {
  it("compose publishes 5433 on the host and keeps 5432 inside the network", () => {
    expect(compose).toMatch(/ports:\s*\["5433:5432"\]/);
  });

  it("the compose dbt service names the IN-NETWORK port, not the published one", () => {
    // Reading the service block rather than the whole file: a DBT_PORT anywhere would
    // otherwise satisfy this while sitting on the wrong service.
    const dbtService = compose.slice(compose.indexOf("\n  dbt:"));
    expect(dbtService).toContain("DBT_HOST: postgres");
    expect(
      dbtService,
      'the compose dbt service must set DBT_PORT: "5432" — it reaches postgres over the ' +
        "compose network, where the host's 5433 publication does not exist",
    ).toMatch(/DBT_PORT:\s*"5432"/);
  });

  it("CI's dbt step names the HOST port, because it runs on the runner not in the network", () => {
    expect(ci).toContain("DBT_HOST: localhost");
    expect(ci).toMatch(/DBT_PORT:\s*"5433"/);
  });

  it("profiles.yml's default is the host port and says which contexts override it", () => {
    expect(profiles).toMatch(/env_var\('DBT_PORT',\s*'5433'\)/);
    // The comment is load-bearing: it is the only thing standing between the next
    // person and re-breaking one context by fixing the other. It must name BOTH.
    expect(profiles).toContain("docker-compose.yml");
    expect(profiles).toContain("5432");
  });
});
