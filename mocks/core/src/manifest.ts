import { prng } from "./prng.js";

export type Profile = "generic" | "plumbing" | "saas" | "logistics";

export type Company = { id: string; name: string; domain: string; owner_email: string };
export type Contact = { id: string; company_id: string; name: string; email: string };
export type Deal = { id: string; company_id: string; name: string; amount_cents: number; status: "open" | "won" | "lost" };
export type MergePair = { from_id: string; to_id: string };
export type BillingCustomer = { id: string; name: string; domain: string; email: string };
export type Invoice = { id: string; customer_id: string; amount_cents: number; currency: "USD" };
export type SupportRequester = { id: string; name: string; email: string; company_name: string; domain: string };
export type Ticket = {
  id: string; requester_id: string; subject: string; priority: "normal" | "high";
  created_at: string; sla_due_at: string; solved_at: string;
};

export type Manifest = {
  crm: { companies: Company[]; contacts: Contact[]; deals: Deal[]; mergePairs: MergePair[] };
  billing: { customers: BillingCustomer[]; invoices: Invoice[] };
  support: { requesters: SupportRequester[]; tickets: Ticket[] };
  expectations: {
    canonicalCompanyCount: number; // 20: 22 staged companies − 2 merged away
    tier1: { billing: string[]; support: string[] };   // entity ids that MUST resolve tier 1
    tier2: { billing: string[]; support: string[] };   // MUST resolve tier 2
    manualReview: { billing: string[]; support: string[] }; // MUST land in manual_review (tier 3)
    mergePairs: MergePair[];
    crossSystemCompanyIds: string[]; // canonical CRM ids present in all three systems
  };
};

const SECTORS = ["Logistics", "Manufacturing", "Retail", "Consulting", "Media",
  "Freight", "Staffing", "Catering", "Printing", "Security"];
const STATUSES: Deal["status"][] = ["open", "won", "lost"];
const pad = (n: number) => String(n).padStart(4, "0");

export function generateManifest(masterSeed = 42, profile: Profile = "generic"): Manifest {
  if (profile !== "generic") {
    // D4: the parameter seam ships in 2a; vertical CONTENT (plumbing|saas|logistics) is Phase 2b.
    throw new Error(`profile "${profile}" not implemented until Phase 2b (only "generic" in 2a)`);
  }
  const rand = prng(masterSeed);

  // 20 base companies — identical construction to the Phase 0/1 seed (ids/names/domains stable).
  const base: Company[] = Array.from({ length: 20 }, (_, i) => {
    const sector = SECTORS[i % SECTORS.length];
    const slug = `${sector.toLowerCase()}-${i + 1}`;
    return {
      id: `DEMO-C-${pad(i + 1)}`,
      name: `DEMO ${sector} Group ${i + 1}`,
      domain: `${slug}.example.com`,
      owner_email: `owner.${slug}@example.com`,
    };
  });
  // ~8% seeded duplicates (2 of 22): dupes of C-0001/C-0002 — same domain, name variant.
  const dupes: Company[] = [
    { id: "DEMO-C-0021", name: `${base[0].name} Inc`, domain: base[0].domain, owner_email: "owner.logistics-1b@example.com" },
    { id: "DEMO-C-0022", name: base[1].name, domain: base[1].domain, owner_email: "owner.manufacturing-2b@example.com" },
  ];
  const companies = [...base, ...dupes];
  const mergePairs: MergePair[] = [
    { from_id: "DEMO-C-0021", to_id: "DEMO-C-0001" },
    { from_id: "DEMO-C-0022", to_id: "DEMO-C-0002" },
  ];

  // NEW entity (original spec §2, D4): 2 contacts per base company.
  const contacts: Contact[] = base.flatMap((c, i) => {
    const slug = c.domain.replace(".example.com", "");
    return [0, 1].map((k) => ({
      id: `DEMO-P-${pad(i * 2 + k + 1)}`,
      company_id: c.id,
      name: `DEMO Contact ${i * 2 + k + 1}`,
      email: `contact${k + 1}.${slug}@example.com`,
    }));
  });

  // 60 deals: 56 across base companies (same construction as Phase 1), 4 on the dupes so
  // merge collapse demonstrably re-points history (deal rollup moves to the canonical id).
  const deals: Deal[] = [
    ...Array.from({ length: 56 }, (_, i) => ({
      id: `DEMO-D-${pad(i + 1)}`,
      company_id: base[Math.floor(rand() * base.length)].id,
      name: `DEMO Deal ${i + 1}`,
      amount_cents: Math.floor(rand() * 5_000_000) + 50_000,
      status: STATUSES[Math.floor(rand() * STATUSES.length)],
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `DEMO-D-${pad(57 + i)}`,
      company_id: dupes[i % 2].id,
      name: `DEMO Deal ${57 + i}`,
      amount_cents: Math.floor(rand() * 5_000_000) + 50_000,
      status: STATUSES[Math.floor(rand() * STATUSES.length)],
    })),
  ];

  // Billing: 16 customers. 1–10 tier-1 (exact contact email); 11–13 tier-2 (domain+name with
  // normalization variants); 14 near-miss (name matches, domain doesn't → manual review);
  // 15–16 unmatchable (billing-only → manual review + incomplete customer_360 rows, D6).
  const bId = (n: number) => `DEMO-B-${pad(n)}`;
  const customers: BillingCustomer[] = [
    ...base.slice(0, 10).map((c, i) => ({
      id: bId(i + 1), name: c.name, domain: c.domain, email: contacts[i * 2].email,
    })),
    { id: bId(11), name: `${base[10].name} Inc`, domain: base[10].domain, email: "billing.media-11@example.com" },
    { id: bId(12), name: base[11].name.toUpperCase(), domain: `WWW.${base[11].domain}`, email: "billing.freight-12@example.com" },
    { id: bId(13), name: base[12].name, domain: base[12].domain, email: "billing.staffing-13@example.com" },
    { id: bId(14), name: base[13].name, domain: "catering-14b.example.com", email: "billing.catering-14b@example.com" },
    { id: bId(15), name: "DEMO Standalone Billing Co 1", domain: "standalone-billing-1.example.com", email: "billing.standalone1@example.com" },
    { id: bId(16), name: "DEMO Standalone Billing Co 2", domain: "standalone-billing-2.example.com", email: "billing.standalone2@example.com" },
  ];
  const invRand = prng(masterSeed + 1);
  const invoices: Invoice[] = Array.from({ length: 40 }, (_, i) => ({
    id: `DEMO-I-${pad(i + 1)}`,
    customer_id: customers[i % customers.length].id,
    amount_cents: Math.floor(invRand() * 2_000_000) + 10_000,
    currency: "USD",
  }));

  // Support: 14 requesters. 1–9 tier-1 (contact emails of companies 6–14 → companies 6–10
  // overlap billing = cross-system entities); 10–11 tier-2 (normalization variants);
  // 12 near-miss (domain matches C-0017, name doesn't); 13–14 unmatchable.
  const sId = (n: number) => `DEMO-S-${pad(n)}`;
  const requesters: SupportRequester[] = [
    ...base.slice(5, 14).map((c, i) => ({
      id: sId(i + 1), name: `DEMO Requester ${i + 1}`, email: contacts[(i + 5) * 2].email,
      company_name: c.name, domain: c.domain,
    })),
    { id: sId(10), name: "DEMO Requester 10", email: "help.security-15@example.com", company_name: `${base[14].name} LLC`, domain: base[14].domain },
    { id: sId(11), name: "DEMO Requester 11", email: "help.freight-16@example.com", company_name: base[15].name, domain: `www.${base[15].domain}` },
    { id: sId(12), name: "DEMO Requester 12", email: "help.printing-17b@example.com", company_name: "DEMO Totally Different Name", domain: base[16].domain },
    { id: sId(13), name: "DEMO Requester 13", email: "help.standalone1@example.com", company_name: "DEMO Standalone Support Co 1", domain: "standalone-support-1.example.com" },
    { id: sId(14), name: "DEMO Requester 14", email: "help.standalone2@example.com", company_name: "DEMO Standalone Support Co 2", domain: "standalone-support-2.example.com" },
  ];
  const BASE_T = Date.parse("2026-07-01T00:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const tickets: Ticket[] = Array.from({ length: 30 }, (_, i) => {
    const priority = i % 3 === 0 ? "high" as const : "normal" as const;
    const created = BASE_T + i * 3_600_000;
    const slaHours = priority === "high" ? 24 : 72;
    const solveHours = (i % 5) * 20; // deterministic: some breach (e.g. high + 80h), some don't
    return {
      id: `DEMO-T-${pad(i + 1)}`,
      requester_id: requesters[i % requesters.length].id,
      subject: `DEMO Ticket ${i + 1}`,
      priority,
      created_at: iso(created),
      sla_due_at: iso(created + slaHours * 3_600_000),
      solved_at: iso(created + solveHours * 3_600_000),
    };
  });

  return {
    crm: { companies, contacts, deals, mergePairs },
    billing: { customers, invoices },
    support: { requesters, tickets },
    expectations: {
      canonicalCompanyCount: 20,
      tier1: {
        billing: customers.slice(0, 10).map((c) => c.id),
        support: requesters.slice(0, 9).map((r) => r.id),
      },
      tier2: { billing: [bId(11), bId(12), bId(13)], support: [sId(10), sId(11)] },
      manualReview: { billing: [bId(14), bId(15), bId(16)], support: [sId(12), sId(13), sId(14)] },
      mergePairs,
      crossSystemCompanyIds: base.slice(5, 10).map((c) => c.id), // C-0006..C-0010
    },
  };
}
