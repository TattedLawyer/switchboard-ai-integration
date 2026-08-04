import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createIngestApp } from "../src/server.js";
import { DEFAULT_TENANT_ID } from "../src/ingest-event.js";

// C3 (phase-close review): the demo/chaos scripts proved the MOCKS were the servers they
// started (fresh_wait) but proved only port-liveness for ingest on 4002. That gap is not
// cosmetic. A stranded ingest from a previous run keeps polling its OWN feed on its OWN
// env, so `CHAOS_SKIP_BACKFILL=1` — whose entire job is to prove reconcile DETECTS loss —
// could reconcile clean and report PASS while proving nothing at all. A detector proof
// that can pass vacuously is the worst defect this repository could ship.
//
// The fix is the documented health-endpoint practice of returning an instance identifier
// so a caller can confirm the answering process is the one it intended to reach, rather
// than inferring it from an open socket. The scripts mint an id per run and assert it
// comes back.

// No database. /status answers from process state alone, and that is deliberate: a probe
// used to decide whether the process answering the port is OURS must not be able to fail
// for an unrelated reason like a slow or unreachable Postgres. The pool below is never
// connected, which also pins that property — if /status ever grows a query, these go red.
const pool = new pg.Pool({ connectionString: "postgres://unused:unused@127.0.0.1:1/unused" });
const savedEnv = process.env.INGEST_INSTANCE_ID;

afterEach(() => {
  if (savedEnv === undefined) delete process.env.INGEST_INSTANCE_ID;
  else process.env.INGEST_INSTANCE_ID = savedEnv;
});

async function getStatus(app: ReturnType<typeof createIngestApp>) {
  const srv = app.listen(0);
  try {
    const port = (srv.address() as { port: number }).port;
    const res = await fetch(`http://localhost:${port}/status`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    srv.close();
  }
}

describe("ingest /status — proves WHICH process answered, not just that one did", () => {
  it("echoes the instance id the process was started with", async () => {
    process.env.INGEST_INSTANCE_ID = "run-abc-123";
    const { status, body } = await getStatus(createIngestApp(pool, DEFAULT_TENANT_ID));
    expect(status).toBe(200);
    expect(body.instance_id).toBe("run-abc-123");
  });

  it("reports a different id for a process started under a different id — which is the whole point: a caller comparing ids catches a leftover server that a port check cannot", async () => {
    process.env.INGEST_INSTANCE_ID = "run-first";
    const first = await getStatus(createIngestApp(pool, DEFAULT_TENANT_ID));
    process.env.INGEST_INSTANCE_ID = "run-second";
    const second = await getStatus(createIngestApp(pool, DEFAULT_TENANT_ID));
    expect(first.body.instance_id).toBe("run-first");
    expect(second.body.instance_id).toBe("run-second");
    expect(first.body.instance_id).not.toBe(second.body.instance_id);
  });

  it("does not fail when no id is set — unset means 'nobody is checking', not an error, so ad-hoc local runs and the manual RUNBOOK path keep working", async () => {
    delete process.env.INGEST_INSTANCE_ID;
    const { status, body } = await getStatus(createIngestApp(pool, DEFAULT_TENANT_ID));
    expect(status).toBe(200);
    expect(body.instance_id).toBeNull();
  });

  it("leaks nothing beyond the identity fields — /status is unauthenticated, so it must not become a reconnaissance surface", async () => {
    process.env.INGEST_INSTANCE_ID = "run-abc-123";
    const { body } = await getStatus(createIngestApp(pool, DEFAULT_TENANT_ID));
    expect(Object.keys(body).sort()).toEqual(["instance_id", "service"]);
    expect(JSON.stringify(body)).not.toMatch(/postgres|password|secret|DATABASE_URL/i);
  });
});
