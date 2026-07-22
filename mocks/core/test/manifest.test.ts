import { describe, expect, it } from "vitest";
import { generateManifest } from "../src/manifest.js";

describe("generateManifest", () => {
  it("is deterministic for the same master seed", () => {
    expect(generateManifest(42)).toEqual(generateManifest(42));
  });
  it("plants the identity matrix: 22 companies (2 dupes ≈ 8%), 40 contacts, 60 deals, merge pairs on the dupes", () => {
    const m = generateManifest();
    expect(m.crm.companies).toHaveLength(22);
    expect(m.crm.contacts).toHaveLength(40);
    expect(m.crm.deals).toHaveLength(60);
    expect(m.crm.mergePairs).toEqual([
      { from_id: "DEMO-C-0021", to_id: "DEMO-C-0001" },
      { from_id: "DEMO-C-0022", to_id: "DEMO-C-0002" },
    ]);
    // dupes share the canonical's domain (that's what makes them dupes)
    const byId = new Map(m.crm.companies.map((c) => [c.id, c]));
    expect(byId.get("DEMO-C-0021")!.domain).toBe(byId.get("DEMO-C-0001")!.domain);
  });
  it("tier-1 rows reuse exact contact emails; manual-review rows share no contact email", () => {
    const m = generateManifest();
    const contactEmails = new Set(m.crm.contacts.map((c) => c.email));
    for (const id of m.expectations.tier1.billing) {
      const cust = m.billing.customers.find((c) => c.id === id)!;
      expect(contactEmails.has(cust.email)).toBe(true);
    }
    for (const id of [...m.expectations.tier2.billing, ...m.expectations.manualReview.billing]) {
      const cust = m.billing.customers.find((c) => c.id === id)!;
      expect(contactEmails.has(cust.email)).toBe(false);
    }
  });
  it("every billing customer and support requester is classified exactly once in expectations", () => {
    const m = generateManifest();
    const b = [...m.expectations.tier1.billing, ...m.expectations.tier2.billing, ...m.expectations.manualReview.billing];
    expect(b.sort()).toEqual(m.billing.customers.map((c) => c.id).sort());
    expect(new Set(b).size).toBe(b.length);
    const s = [...m.expectations.tier1.support, ...m.expectations.tier2.support, ...m.expectations.manualReview.support];
    expect(s.sort()).toEqual(m.support.requesters.map((r) => r.id).sort());
  });
  it("stubs non-generic profiles until 2b (the seam exists, the content does not)", () => {
    expect(() => generateManifest(42, "plumbing")).toThrow(/Phase 2b/);
  });
});
