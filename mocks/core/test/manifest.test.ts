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
  it("crossSystemCompanyIds equals the independently-computed set of companies present in all three systems", () => {
    const m = generateManifest();
    // Independent resolver over the manifest DATA (not the expectations literals), mirroring
    // the tier criteria the manifest encodes:
    //   tier 1 — entity email is an exact CRM contact email → that contact's company;
    //   tier 2 — entity domain matches a canonical company domain after normalization
    //            (case, leading "www.") AND its name matches after normalization
    //            (case, trailing Inc/LLC suffix).
    const normDomain = (d: string) => d.toLowerCase().replace(/^www\./, "");
    const normName = (n: string) => n.toLowerCase().replace(/\s+(inc|llc)\.?$/, "").trim();
    const mergedAway = new Set(m.crm.mergePairs.map((p) => p.from_id));
    const canonical = m.crm.companies.filter((c) => !mergedAway.has(c.id));
    const companyByContactEmail = new Map(m.crm.contacts.map((p) => [p.email, p.company_id]));
    const companyByDomain = new Map(canonical.map((c) => [normDomain(c.domain), c]));
    const resolve = (e: { email: string; domain: string; name: string }): string | null => {
      const tier1 = companyByContactEmail.get(e.email);
      if (tier1) return tier1;
      const co = companyByDomain.get(normDomain(e.domain));
      return co && normName(co.name) === normName(e.name) ? co.id : null;
    };

    // The resolver must agree with the manifest's own tier classification, so the
    // independent computation below is trustworthy.
    for (const c of m.billing.customers) {
      const expected = m.expectations.manualReview.billing.includes(c.id) ? null : "resolved";
      expect(resolve(c) === null ? null : "resolved").toBe(expected);
    }
    for (const r of m.support.requesters) {
      const e = { email: r.email, domain: r.domain, name: r.company_name };
      const expected = m.expectations.manualReview.support.includes(r.id) ? null : "resolved";
      expect(resolve(e) === null ? null : "resolved").toBe(expected);
    }

    // Cross-system = company ids with BOTH a billing entity AND a support entity resolving
    // to them (any tier). Computed here from scratch — never copied from the field under test.
    const billingCompanyIds = new Set(
      m.billing.customers.map((c) => resolve(c)).filter((id): id is string => id !== null),
    );
    const computed = [...new Set(
      m.support.requesters
        .map((r) => resolve({ email: r.email, domain: r.domain, name: r.company_name }))
        .filter((id): id is string => id !== null && billingCompanyIds.has(id)),
    )].sort();
    expect([...m.expectations.crossSystemCompanyIds].sort()).toEqual(computed);
  });
});
