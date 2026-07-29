// Seeded sheet content — every name/email/company/deal comes from the EXISTING
// synthetic universe (@switchboard/mock-core manifest, master seed 42, same default as
// the other mocks). No new identity generation: identity resolution must be able to
// match these rows later, and the repo-wide hygiene scan must stay green.

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

// Deterministic stream of broker-flavored-but-generic book-of-business rows drawn from
// the manifest universe. Same seed → identical stream.
export function createRowSource(_seed: number): RowContentSource {
  throw new Error("not implemented (RED)");
}
