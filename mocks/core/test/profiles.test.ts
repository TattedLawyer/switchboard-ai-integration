import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { generateManifest, PROFILES, type Manifest, type Profile } from "../src/manifest.js";

// Phase 2b Task E (2b-D3): vertical seed profiles `plumbing | saas | realestate` on the
// D4 generator seam. The horizontal thesis, machine-checked: what varies by profile is
// VOCABULARY and VALUE RANGES (naming flavor, deal/invoice types, ticket subjects,
// plausible amounts); what does not vary is structure — entity counts, id schemes, the
// dupe/merge construction, the tier-1/2/3 expectation discipline, and the
// derived-not-hand-maintained expectations rule. Every invariant here runs over ALL
// profiles, so vertical N+1 stays a configuration exercise, not a fork.

const hashOf = (m: Manifest): string =>
  createHash("sha256").update(JSON.stringify(m)).digest("hex");

/** Same (seed, profile) in a FRESH process — determinism must survive the process
 *  boundary, not just PRNG-state luck inside one. */
function childHash(profile: Profile, seed: number): string {
  const manifestUrl = new URL("../src/manifest.ts", import.meta.url).href;
  const script =
    `import { generateManifest } from ${JSON.stringify(manifestUrl)};\n` +
    `import { createHash } from "node:crypto";\n` +
    `console.log(createHash("sha256").update(JSON.stringify(generateManifest(${seed}, ${JSON.stringify(profile)}))).digest("hex"));`;
  return execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    encoding: "utf8",
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    timeout: 30_000,
  }).trim();
}

it("the profile union is the 2b-D3 trio plus generic — logistics is out, realestate is in", () => {
  expect([...PROFILES]).toEqual(["generic", "plumbing", "saas", "realestate"]);
});

it("an unknown profile name is refused BY NAME, listing every valid profile — the error is an operator surface, not a stack trace from undefined content", () => {
  expect(() => generateManifest(42, "logistics" as Profile)).toThrow(
    /unknown profile "logistics".*generic, plumbing, saas, realestate/,
  );
});

describe.each(PROFILES.map((p) => [p] as const))("profile %s", (profile) => {
  const m = generateManifest(42, profile);

  it("is deterministic: same (seed, profile) → identical manifest, twice in-process and across a process boundary", () => {
    expect(generateManifest(42, profile)).toEqual(m);
    expect(childHash(profile, 42)).toBe(hashOf(m));
  });

  it("keeps the identity-matrix STRUCTURE: entity counts, id schemes, and the dupe/merge construction are profile-invariant", () => {
    expect(m.crm.companies).toHaveLength(22);
    expect(m.crm.contacts).toHaveLength(40);
    expect(m.crm.deals).toHaveLength(60);
    expect(m.billing.customers).toHaveLength(16);
    expect(m.billing.invoices).toHaveLength(40);
    expect(m.support.requesters).toHaveLength(14);
    expect(m.support.tickets).toHaveLength(30);
    expect(m.expectations.canonicalCompanyCount).toBe(20);
    expect(m.crm.mergePairs).toEqual([
      { from_id: "DEMO-C-0021", to_id: "DEMO-C-0001" },
      { from_id: "DEMO-C-0022", to_id: "DEMO-C-0002" },
    ]);
    const byId = new Map(m.crm.companies.map((c) => [c.id, c]));
    for (const { from_id, to_id } of m.crm.mergePairs) {
      expect(byId.get(from_id)!.domain).toBe(byId.get(to_id)!.domain); // what makes them dupes
    }
    const idShapes: [string, RegExp][] = [
      ...m.crm.companies.map((e): [string, RegExp] => [e.id, /^DEMO-C-\d{4}$/]),
      ...m.crm.contacts.map((e): [string, RegExp] => [e.id, /^DEMO-P-\d{4}$/]),
      ...m.crm.deals.map((e): [string, RegExp] => [e.id, /^DEMO-D-\d{4}$/]),
      ...m.billing.customers.map((e): [string, RegExp] => [e.id, /^DEMO-B-\d{4}$/]),
      ...m.billing.invoices.map((e): [string, RegExp] => [e.id, /^DEMO-I-\d{4}$/]),
      ...m.support.requesters.map((e): [string, RegExp] => [e.id, /^DEMO-S-\d{4}$/]),
      ...m.support.tickets.map((e): [string, RegExp] => [e.id, /^DEMO-T-\d{4}$/]),
    ];
    for (const [id, shape] of idShapes) expect(id).toMatch(shape);
  });

  it("expectation sets stay non-empty, tier-partitioned, and exactly cover every billing customer and support requester", () => {
    const e = m.expectations;
    expect(e.tier1.billing).toHaveLength(10);
    expect(e.tier2.billing).toHaveLength(3);
    expect(e.manualReview.billing).toHaveLength(3);
    expect(e.tier1.support).toHaveLength(9);
    expect(e.tier2.support).toHaveLength(2);
    expect(e.manualReview.support).toHaveLength(3);
    const b = [...e.tier1.billing, ...e.tier2.billing, ...e.manualReview.billing];
    expect(new Set(b).size).toBe(b.length);
    expect([...b].sort()).toEqual(m.billing.customers.map((c) => c.id).sort());
    const s = [...e.tier1.support, ...e.tier2.support, ...e.manualReview.support];
    expect(new Set(s).size).toBe(s.length);
    expect([...s].sort()).toEqual(m.support.requesters.map((r) => r.id).sort());
  });

  it("tier-1 rows reuse exact contact emails; tier-2 and manual-review rows share no contact email — the oracle's tier criteria hold per profile", () => {
    const contactEmails = new Set(m.crm.contacts.map((c) => c.email));
    for (const id of m.expectations.tier1.billing) {
      expect(contactEmails.has(m.billing.customers.find((c) => c.id === id)!.email)).toBe(true);
    }
    for (const id of [...m.expectations.tier2.billing, ...m.expectations.manualReview.billing]) {
      expect(contactEmails.has(m.billing.customers.find((c) => c.id === id)!.email)).toBe(false);
    }
    for (const id of m.expectations.tier1.support) {
      expect(contactEmails.has(m.support.requesters.find((r) => r.id === id)!.email)).toBe(true);
    }
    for (const id of [...m.expectations.tier2.support, ...m.expectations.manualReview.support]) {
      expect(contactEmails.has(m.support.requesters.find((r) => r.id === id)!.email)).toBe(false);
    }
  });

  it("crossSystemCompanyIds equals an independently-computed all-three-systems set (derived-expectations discipline, per profile)", () => {
    // Independent resolver over the manifest DATA, mirroring the tier criteria — the
    // same recomputation manifest.test.ts pins for generic, run against every profile.
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
    for (const c of m.billing.customers) {
      const expected = m.expectations.manualReview.billing.includes(c.id) ? null : "resolved";
      expect(resolve(c) === null ? null : "resolved", c.id).toBe(expected);
    }
    for (const r of m.support.requesters) {
      const e = { email: r.email, domain: r.domain, name: r.company_name };
      const expected = m.expectations.manualReview.support.includes(r.id) ? null : "resolved";
      expect(resolve(e) === null ? null : "resolved", r.id).toBe(expected);
    }
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

  it("stays fully synthetic: DEMO markers on every id and name, only *.example.com emails and domains, no SSN- or phone-shaped strings (the hygiene wall, per profile)", () => {
    const blob = JSON.stringify(m);
    const emails = blob.match(/[\w.+-]+@[\w.-]+/g) ?? [];
    expect(emails.length).toBeGreaterThan(0);
    expect(emails.filter((e) => !e.toLowerCase().endsWith("@example.com"))).toEqual([]);
    expect(blob).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
    expect(blob).not.toMatch(/\b\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/);
    for (const c of m.crm.companies) expect(c.domain).toMatch(/^[a-z0-9-]+\.example\.com$/);
    for (const r of m.support.requesters) expect(r.domain.toLowerCase().replace(/^www\./, "")).toMatch(/^[a-z0-9-]+\.example\.com$/);
    const names = [
      ...m.crm.companies.map((c) => c.name),
      ...m.crm.contacts.map((c) => c.name),
      ...m.crm.deals.map((d) => d.name),
      ...m.billing.customers.map((c) => c.name),
      ...m.support.requesters.map((r) => r.name),
      ...m.support.requesters.map((r) => r.company_name),
      ...m.support.tickets.map((t) => t.subject),
    ];
    expect(names.filter((n) => !n.startsWith("DEMO"))).toEqual([]);
  });
});

describe("the profiles genuinely differ (same pipeline, different vertical content)", () => {
  const manifests = PROFILES.map((p) => [p, generateManifest(42, p)] as const);

  it("company names, deal names, and ticket subjects are pairwise disjoint across profiles at the same seed", () => {
    for (const pick of [
      (m: Manifest) => m.crm.companies.map((c) => c.name),
      (m: Manifest) => m.crm.deals.map((d) => d.name),
      (m: Manifest) => m.support.tickets.map((t) => t.subject),
    ]) {
      for (let i = 0; i < manifests.length; i++) {
        for (let j = i + 1; j < manifests.length; j++) {
          const a = new Set(pick(manifests[i][1]));
          const overlap = pick(manifests[j][1]).filter((n) => a.has(n));
          expect(overlap, `${manifests[i][0]} vs ${manifests[j][0]}`).toEqual([]);
        }
      }
    }
  });

  it("value ranges are vertical-plausible and distinct: a plumbing job, a SaaS ARR deal, and a real-estate closing do not share a price band", () => {
    const maxDeal = (m: Manifest) => Math.max(...m.crm.deals.map((d) => d.amount_cents));
    const byProfile = Object.fromEntries(manifests.map(([p, m]) => [p, maxDeal(m)]));
    // Plumbing tops out well under the SaaS band; SaaS under real estate's closing band.
    expect(byProfile.plumbing).toBeLessThan(2_000_000); // < $20k
    expect(byProfile.saas).toBeGreaterThan(byProfile.plumbing);
    expect(byProfile.realestate).toBeGreaterThan(byProfile.saas);
  });
});
