// Seeded sheet content — every name/email/company/deal comes from the EXISTING
// synthetic universe (@switchboard/mock-core manifest, master seed 42, same default as
// the other mocks). No new identity generation: identity resolution must be able to
// match these rows later, and the repo-wide hygiene scan must stay green.

import { generateManifest, prng } from "@switchboard/mock-core";

export const SHEET_HEADER = [
  "Client Name", "Email", "Company", "Deal", "Amount",
  "Currency", "Status", "Close Date", "Notes",
] as const;

// Canonical column POSITIONS. Header renames change the header TEXT only — positions
// are stable in this mock (column insert/delete is not a modeled operation).
export const COL = {
  clientName: 0, email: 1, company: 2, deal: 3, amount: 4,
  currency: 5, status: 6, closeDate: 7, notes: 8,
} as const;

export type RowContentSource = { next(): string[] };

// One manifest for the whole mock — same fixed master seed (42) the other mock sources
// default to, so the sheet's people/companies/deals are the SAME universe the CRM,
// billing, and support mocks emit.
const manifest = generateManifest(42);
const { contacts, companies, deals } = manifest.crm;
const companyById = new Map(companies.map((c) => [c.id, c]));

// Sheets are stringly-typed: everything renders as the string a human would see.
const amountString = (cents: number) => (cents / 100).toFixed(2);
const dateString = (r: () => number) => `2026-07-${String(1 + Math.floor(r() * 28)).padStart(2, "0")}`;

// Deterministic stream of broker-flavored-but-generic book-of-business rows drawn from
// the manifest universe. Same seed → identical stream.
export function createRowSource(seed: number): RowContentSource {
  const rand = prng(seed);
  return {
    next(): string[] {
      const contact = contacts[Math.floor(rand() * contacts.length)];
      const company = companyById.get(contact.company_id)!;
      const deal = deals[Math.floor(rand() * deals.length)];
      const cells = new Array<string>(SHEET_HEADER.length);
      cells[COL.clientName] = contact.name;
      cells[COL.email] = contact.email;
      cells[COL.company] = company.name;
      cells[COL.deal] = deal.name;
      cells[COL.amount] = amountString(deal.amount_cents);
      cells[COL.currency] = deal.currency; // "USD" — garbage variants are the EDITOR's doing
      cells[COL.status] = deal.status;
      cells[COL.closeDate] = dateString(rand);
      cells[COL.notes] = rand() < 0.5 ? `ref ${deal.id}` : "";
      return cells;
    },
  };
}

// Editors also need manifest-derived REPLACEMENT values for in-place cell edits.
export function editValueSource(rand: () => number) {
  return {
    amount: () => amountString(deals[Math.floor(rand() * deals.length)].amount_cents),
    status: () => (["open", "won", "lost"] as const)[Math.floor(rand() * 3)],
    closeDate: () => dateString(rand),
    notes: () => `ref ${deals[Math.floor(rand() * deals.length)].id}`,
  };
}
