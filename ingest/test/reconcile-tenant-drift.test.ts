import { describe, expect, it } from "vitest";
import { connectorForTenant } from "../src/cli/reconcile.js";
import { connectorFor } from "../src/connectors/index.js";
import { SOURCES, type Source } from "../src/sources.js";
import { DEFAULT_TENANT_ID } from "../src/ingest-event.js";

// Sweep item 4 (slice-1 review Minor), NARROWED at CLOSE-3 close-out.
//
// Originally: connectorForTenant duplicated the registry's per-kind construction switch,
// because the registry built default-tenant connectors and the seam had no tenant
// parameter. Duplication without a drift test is how two paths quietly diverge, so this
// file asserted the two agreed.
//
// The registry now takes the tenant, so connectorForTenant is a thin wrapper around it and
// the duplication is GONE. The two "agrees with the registry" assertions that used to earn
// this file were therefore comparing a function with itself: they could not fail, for any
// edit, ever. A pin that cannot red is worse than no pin, because it reads like coverage
// — so they are deleted rather than left as decoration.
//
// What remains genuinely binds, and is what this file is now for:
//   - the REGISTRY-SHAPE enumeration: exactly which sources are tenant-capable. If a source
//     is added, or changes paradigm, this list must move deliberately.
//   - the LEDGER-FEED REFUSAL, which is a reconcile-specific rule living in
//     connectorForTenant and in nothing the registry does.

const TENANT = "7d7f7b7a-0000-4000-8000-000000000042";

/** Both paths' connectors store their construction options as a private `opts` field
 *  (ledger-feed stores `source` instead and is tenant-refusing — asserted separately). */
function optsOf(c: unknown): Record<string, unknown> {
  return { ...((c as { opts?: Record<string, unknown> }).opts ?? {}) };
}

describe("the registry's tenant shape, and reconcile's ledger-feed refusal", () => {
  it("exactly four sources are tenant-capable — a new source or a changed paradigm must move this list deliberately", () => {
    const tenantCapable = SOURCES.filter((s) => connectorFor(s, DEFAULT_TENANT_ID).kind !== "ledger-feed");
    expect(tenantCapable).toEqual(["sheets", "stripefeed", "hubcrm", "casebus"]);
  });

  it("every tenant-capable source is constructed WITH the tenant it was asked for, and with nothing else changed", () => {
    const tenantCapable = SOURCES.filter((s) => connectorFor(s, DEFAULT_TENANT_ID).kind !== "ledger-feed");
    for (const source of tenantCapable) {
      const scoped = optsOf(connectorForTenant(source, TENANT));
      const base = optsOf(connectorFor(source, DEFAULT_TENANT_ID));
      // The tenant actually reaches the constructor — the whole point of the fix round.
      expect(scoped.tenantId, source).toBe(TENANT);
      expect(base.tenantId, source).toBe(DEFAULT_TENANT_ID);
      // …and it is the ONLY thing that differs. If the registry ever constructs with more
      // than baseUrl (batch sizes, fallback presets…), asking for a tenant must not
      // silently drop it. This still binds: the two calls pass different arguments.
      delete scoped.tenantId;
      delete base.tenantId;
      expect(scoped, source).toEqual(base);
    }
  });

  it("ledger-feed sources refuse a non-default tenant by name on this path too (the CLI refuses earlier; this is the backstop)", () => {
    for (const source of SOURCES.filter((s) => connectorFor(s, DEFAULT_TENANT_ID).kind === "ledger-feed") as Source[]) {
      expect(() => connectorForTenant(source, TENANT)).toThrow(/--tenant is not supported for ledger-feed source/);
    }
  });
});
