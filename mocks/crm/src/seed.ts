import { generateManifest, type Company, type Contact, type Deal } from "@switchboard/mock-core";
export { prng } from "@switchboard/mock-core";
export type { Company, Contact, Deal };
export function generateSeed(seed = 42): { companies: Company[]; contacts: Contact[]; deals: Deal[] } {
  const m = generateManifest(seed);
  return { companies: m.crm.companies, contacts: m.crm.contacts, deals: m.crm.deals };
}
