export type Company = { id: string; name: string; domain: string; owner_email: string };
export type Deal = { id: string; company_id: string; name: string; amount_cents: number; status: "open" | "won" | "lost" };

// mulberry32 PRNG — deterministic, dependency-free
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SECTORS = ["Logistics", "Manufacturing", "Retail", "Consulting", "Media",
  "Freight", "Staffing", "Catering", "Printing", "Security"];
const STATUSES: Deal["status"][] = ["open", "won", "lost"];

export function generateSeed(seed = 42): { companies: Company[]; deals: Deal[] } {
  const rand = prng(seed);
  const pad = (n: number) => String(n).padStart(4, "0");
  const companies: Company[] = Array.from({ length: 20 }, (_, i) => {
    const sector = SECTORS[i % SECTORS.length];
    const slug = `${sector.toLowerCase()}-${i + 1}`;
    return {
      id: `DEMO-C-${pad(i + 1)}`,
      name: `DEMO ${sector} Group ${i + 1}`,
      domain: `${slug}.example.com`,
      owner_email: `owner.${slug}@example.com`,
    };
  });
  const deals: Deal[] = Array.from({ length: 60 }, (_, i) => ({
    id: `DEMO-D-${pad(i + 1)}`,
    company_id: companies[Math.floor(rand() * companies.length)].id,
    name: `DEMO Deal ${i + 1}`,
    amount_cents: Math.floor(rand() * 5_000_000) + 50_000,
    status: STATUSES[Math.floor(rand() * STATUSES.length)],
  }));
  return { companies, deals };
}
