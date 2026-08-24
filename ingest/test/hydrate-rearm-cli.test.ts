import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type pg from "pg";
import express from "express";
import { freshTestDb } from "./helpers/testdb.js";
import { cliEnv } from "./helpers/child-env.js";
import { createHubcrmApp, type HubcrmApp } from "../../mocks/hubcrm/src/index.js";
import {
  HubHydrateConnector,
  listHydrationDlqJobs,
  sendToHydrationDlq,
  withHydrationDlqBoss,
} from "../src/connectors/hub-hydrate.js";
import { recordGap } from "../src/connectors/types.js";
import { DEFAULT_TENANT_ID } from "../src/ingest-event.js";
import { listenLoopback } from "@switchboard/mock-core";

// Close D2 (the split's close half) — the hydration-DLQ re-arm CLI, pinned by
// child-process runs of the real entrypoint (operator-surface checklist lines 1/3/5).
//
// The paradigm's premise, proven as this suite's own negative control: a dead-lettered
// hydration is TERMINAL — the pump skips DLQ'd event ids — so fixing the vendor-side
// object changes NOTHING until the DLQ row is consumed. Re-arm = consume the row
// (deleteJob; retry() is a documented no-op on this store's 'created' jobs), after which
// the pump re-fetches. Deletion destroys the row, so the CLI's printed output is the
// audit trace: it must name what was re-armed (event, object, recorded reason) + counts.

const INGEST_DIR = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_TENANT = "00000000-0000-0000-0000-000000000000";
const TENANT_B = "33333333-3333-3333-3333-333333333333";

let pool: pg.Pool;
let dbUrl: string;
let cleanup: () => Promise<void>;
const servers: Server[] = [];

beforeEach(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  dbUrl = result.url;
  cleanup = result.cleanup;
});
afterEach(async () => {
  for (const s of servers.splice(0)) s.close();
  await cleanup();
});

async function listen(app: express.Express): Promise<string> {
  const s = await listenLoopback(app);
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

function runCli(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "src/cli/hydrate-rearm.ts", ...args],
      { cwd: INGEST_DIR, timeout: 30_000, env: cliEnv({ DATABASE_URL: dbUrl, ALLOW_DEV_SECRETS: "1" }) },
      (err, stdout, stderr) => {
        if (err && typeof err.code !== "number") return reject(err);
        resolve({ code: err ? (err.code as number) : 0, out: `${stdout}\n${stderr}` });
      },
    );
  });
}

async function deliverThroughDoor(hub: HubcrmApp): Promise<void> {
  const { createIngestApp } = await import("../src/server.js");
  const ingest = createIngestApp(pool, DEFAULT_TENANT_ID);
  const s = await listenLoopback(ingest);
  try {
    const stats = await hub.store.deliver({
      webhookUrl: `http://127.0.0.1:${(s.address() as { port: number }).port}/webhooks/hubcrm`,
    });
    if (stats.failedBatches > 0) throw new Error("test delivery failed");
  } finally {
    s.close();
  }
}

const connector = (baseUrl: string) =>
  new HubHydrateConnector({ tenantId: DEFAULT_TENANT_ID,
    baseUrl,
    databaseUrl: dbUrl,
    timeoutMs: 3000,
    backoff: { baseMs: 1, capMs: 10, maxAttempts: 3 },
  });

const dlqDepth = () => withHydrationDlqBoss(dbUrl, (boss) => listHydrationDlqJobs(boss, DEFAULT_TENANT));

describe("hydrate-rearm CLI — the re-armed event is ACTUALLY re-fetched by the pump, and the printed trace is the audit record", () => {
  it("poisoned fetch dead-letters; the healed store alone changes NOTHING (terminal — the negative control); re-arm consumes the row with a printed trace; the NEXT pump run hydrates it", async () => {
    // Learn the first object's id deterministically, then serve it POISONED.
    const probe = createHubcrmApp({ seed: 13 });
    probe.store.simulate(1);
    const poisonId = probe.store.allObjects()[0].objectId;

    const poisoned = createHubcrmApp({ seed: 13, poisonObjectIds: [poisonId] });
    poisoned.store.simulate(1); // one op → one thin event (company creation)
    await deliverThroughDoor(poisoned);
    const eventId = String(poisoned.store.emittedEvents()[0].eventId);
    const poisonedUrl = await listen(poisoned.app);

    const dlqReport = await connector(poisonedUrl).catchUpWithReport(pool);
    expect(dlqReport.hydrationDlq).toBe(1);
    expect(dlqReport.hydrated).toBe(0);

    // The vendor side is FIXED: same seed, same ops, no poison — byte-same store.
    const healed = createHubcrmApp({ seed: 13 });
    healed.store.simulate(1);
    const healedUrl = await listen(healed.app);

    // NEGATIVE CONTROL (the pre-CLI world): a healed vendor does not un-dead-letter
    // anything — the pump still skips the DLQ'd id. This is the terminal-until-operator-
    // acts premise the CLI exists for.
    const controlReport = await connector(healedUrl).catchUpWithReport(pool);
    expect(controlReport.hydrated).toBe(0);
    expect(controlReport.hydrationDlq).toBe(0); // no NEW dead letters — just the skip
    expect(await dlqDepth()).toHaveLength(1);

    // The listing prints EVERY field the entry carries (checklist line 1).
    const list = await runCli(["--list"]);
    expect(list.code).toBe(0);
    expect(list.out).toMatch(/hydration DLQ depth for tenant .*: 1/);
    expect(list.out).toContain(`event ${eventId} (company:${poisonId})`);
    expect(list.out).toMatch(/DLQ reason: .*(exhausted|500)/);

    // Re-arm: the printed trace IS the audit record (the row is destroyed).
    const rearm = await runCli(["--id", eventId]);
    expect(rearm.code).toBe(0);
    expect(rearm.out).toContain(`re-armed event ${eventId} (company:${poisonId})`);
    expect(rearm.out).toMatch(/DLQ reason: .*(exhausted|500)/); // the recorded failure travels into the trace
    expect(rearm.out).toMatch(/re-armed 1 of 1 dead-lettered hydration\(s\)/);
    expect(rearm.out).toMatch(/0 remain/);
    expect(rearm.out).toMatch(/pump will re-fetch/);
    expect(await dlqDepth()).toHaveLength(0);

    // And the pump REALLY re-fetches it — hydrated, terminal, nothing pending.
    const afterReport = await connector(healedUrl).catchUpWithReport(pool);
    expect(afterReport.hydrated).toBe(1);
    expect(afterReport.hydrationDlq).toBe(0);
    expect(afterReport.hydrationPending).toBe(0);
    const snap = await pool.query(
      "select 1 from ingest.hydrated_snapshots where event_id = $1 and not tombstone",
      [eventId],
    );
    expect(snap.rowCount).toBe(1);
  });

  it("a bogus event id refuses LOUDLY — nothing re-armed, exit 1, and the refusal names its own cause (checklist line 5: siblings excluded)", async () => {
    await withHydrationDlqBoss(dbUrl, (boss) =>
      sendToHydrationDlq(boss, DEFAULT_TENANT, {
        event_id: "evt-real",
        object_type: "deal",
        object_id: "77",
        reason: "hydration exhausted 3 attempts — last: GET answered 500",
      }),
    );
    const res = await runCli(["--id", "evt-nope"]);
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/no hydration DLQ entry for event evt-nope/);
    expect(res.out).toMatch(/nothing was re-armed/);
    expect(res.out).not.toMatch(/no recorded state for tenant/);
    expect(res.out).not.toMatch(/--tenant requires a tenant id/);
    // The real entry is untouched.
    expect(await dlqDepth()).toHaveLength(1);
  });

  it("--tenant scopes listing AND re-arm: tenant B's dead letter is invisible to the default tenant and unreachable by its re-arm; the flag reaches it (non-default-tenant pin)", async () => {
    // Tenant B has recorded state (the F8 gate is about UNKNOWN tenants, not this one).
    await recordGap(pool, {
      tenantId: TENANT_B,
      source: "hubcrm",
      cause: "retention",
      fromEventId: "evt_b_state",
      fromOccurredAt: null,
      toOccurredAt: null,
    });
    await withHydrationDlqBoss(dbUrl, async (boss) => {
      await sendToHydrationDlq(boss, DEFAULT_TENANT, {
        event_id: "evt-default",
        object_type: "company",
        object_id: "1",
        reason: "snapshot failed contract: amount_cents unparseable",
      });
      await sendToHydrationDlq(boss, TENANT_B, {
        event_id: "evt-tenant-b",
        object_type: "contact",
        object_id: "2",
        reason: "hydration exhausted 3 attempts — last: GET answered 500",
      });
    });

    const defaultList = await runCli(["--list"]);
    expect(defaultList.out).toContain("evt-default");
    expect(defaultList.out).not.toContain("evt-tenant-b");

    // Cross-tenant re-arm refuses — and tenant B's row survives.
    const cross = await runCli(["--id", "evt-tenant-b"]);
    expect(cross.code).toBe(1);
    expect(cross.out).toMatch(/no hydration DLQ entry for event evt-tenant-b/);

    const bList = await runCli(["--list", "--tenant", TENANT_B]);
    expect(bList.out).toContain("evt-tenant-b");
    expect(bList.out).not.toContain("evt-default");

    const bRearm = await runCli(["--tenant", TENANT_B, "--id", "evt-tenant-b"]);
    expect(bRearm.code).toBe(0);
    expect(bRearm.out).toContain("re-armed event evt-tenant-b (contact:2)");
    // The default tenant's row is untouched by tenant B's operation.
    expect(await dlqDepth()).toHaveLength(1);
  });

  it("the new surface arrives with the CLI-scoping refusals already on it: bare --tenant and unknown --tenant refuse with the house wordings", async () => {
    const bare = await runCli(["--list", "--tenant"]);
    expect(bare.code).toBe(1);
    expect(bare.out).toMatch(/--tenant requires a tenant id/);

    const unknown = await runCli(["--list", "--tenant", "99999999-9999-4999-8999-999999999999"]);
    expect(unknown.code).toBe(1);
    expect(unknown.out).toMatch(/no recorded state for tenant/);
    expect(unknown.out).not.toMatch(/no dead-lettered hydrations/); // the healthy-empty line must not print
  });
});
