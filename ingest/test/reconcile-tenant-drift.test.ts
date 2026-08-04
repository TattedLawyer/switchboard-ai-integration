import { describe, expect, it } from "vitest";
import { connectorForTenant } from "../src/cli/reconcile.js";
import { connectorFor } from "../src/connectors/index.js";
import { SOURCES, type Source } from "../src/sources.js";
import { DEFAULT_TENANT_ID } from "../src/ingest-event.js";

// Sweep item 4 (slice-1 review Minor): connectorForTenant DUPLICATES the registry's
// wiring — the registry constructs default-tenant connectors and the seam has no tenant
// parameter, so the CLI carries its own per-kind switch. Duplication without a drift
// test is how the two paths quietly diverge: a source added to the registry, or a
// construction option added to one path, would leave `--tenant` runs on a differently
// configured connector than default runs, silently. This pin enumerates every
// registered source and asserts the two paths agree.

const TENANT = "7d7f7b7a-0000-4000-8000-000000000042";

/** Both paths' connectors store their construction options as a private `opts` field
 *  (ledger-feed stores `source` instead and is tenant-refusing — asserted separately). */
function optsOf(c: unknown): Record<string, unknown> {
  return { ...((c as { opts?: Record<string, unknown> }).opts ?? {}) };
}

describe("connectorForTenant agrees with the registry, kind by kind", () => {
  it("default tenant: every registered source gets exactly the registry's connector (class, kind, config)", () => {
    for (const source of SOURCES) {
      const viaTenant = connectorForTenant(source, DEFAULT_TENANT_ID);
      const viaRegistry = connectorFor(source, DEFAULT_TENANT_ID);
      expect(viaTenant.constructor, source).toBe(viaRegistry.constructor);
      expect(viaTenant.kind, source).toBe(viaRegistry.kind);
      expect(optsOf(viaTenant), source).toEqual(optsOf(viaRegistry));
    }
  });

  it("non-default tenant: every tenant-capable source gets the registry's class and config with ONLY the tenant added", () => {
    const tenantCapable = SOURCES.filter((s) => connectorFor(s, DEFAULT_TENANT_ID).kind !== "ledger-feed");
    // The enumeration itself is part of the pin: if the registry gains a source (or a
    // source changes paradigm), this list moves and the assertions below must cover it.
    expect(tenantCapable).toEqual(["sheets", "stripefeed", "hubcrm", "casebus"]);
    for (const source of tenantCapable) {
      const scoped = connectorForTenant(source, TENANT);
      const registry = connectorFor(source, DEFAULT_TENANT_ID);
      expect(scoped.constructor, source).toBe(registry.constructor);
      expect(scoped.kind, source).toBe(registry.kind);
      const scopedOpts = optsOf(scoped);
      expect(scopedOpts.tenantId, source).toBe(TENANT);
      // CLOSE-3 fix round: the registry now constructs WITH a tenant too (that is the
      // fix — no production path can build a nil-tenant connector by omission), so the
      // parity comparison drops the tenant from BOTH sides rather than only the scoped one.
      const registryOpts = optsOf(registry);
      expect(registryOpts.tenantId, source).toBe(DEFAULT_TENANT_ID);
      delete scopedOpts.tenantId;
      delete registryOpts.tenantId;
      // Config parity, tenant aside: if the registry ever constructs with more than
      // baseUrl (batch sizes, fallback presets…), the tenant path must carry it too —
      // this deep-equal is what forces that.
      expect(scopedOpts, source).toEqual(registryOpts);
    }
  });

  it("ledger-feed sources refuse a non-default tenant by name on this path too (the CLI refuses earlier; this is the backstop)", () => {
    for (const source of SOURCES.filter((s) => connectorFor(s, DEFAULT_TENANT_ID).kind === "ledger-feed") as Source[]) {
      expect(() => connectorForTenant(source, TENANT)).toThrow(/--tenant is not supported for ledger-feed source/);
    }
  });
});
