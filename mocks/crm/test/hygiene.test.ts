import { describe, expect, it } from "vitest";
import { generateManifest } from "@switchboard/mock-core";
import { generateSeed } from "../src/seed.js";

// Fixture hygiene runs over BOTH the CRM seed adapter and the full cross-system
// manifest (crm + billing + support) so every new entity type is covered.
const blobs: [string, string][] = [
  ["generateSeed", JSON.stringify(generateSeed())],
  ["generateManifest", JSON.stringify(generateManifest())],
];

describe.each(blobs)("fixture hygiene (%s)", (_label, blob) => {
  it("uses only example.com emails", () => {
    const emails = blob.match(/[\w.+-]+@[\w.-]+/g) ?? [];
    expect(emails.length).toBeGreaterThan(0);
    expect(emails.every((e) => e.toLowerCase().endsWith("@example.com"))).toBe(true);
  });
  it("contains no SSN- or US-phone-shaped strings", () => {
    expect(blob).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
    expect(blob).not.toMatch(/\b\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/);
  });
});

describe("fixture hygiene (entity ids and names)", () => {
  const m = generateManifest();
  it("prefixes every id across all sources with DEMO-", () => {
    const ids = [
      ...m.crm.companies.map((c) => c.id),
      ...m.crm.contacts.map((c) => c.id),
      ...m.crm.deals.map((d) => d.id),
      ...m.billing.customers.map((c) => c.id),
      ...m.billing.invoices.map((i) => i.id),
      ...m.support.requesters.map((r) => r.id),
      ...m.support.tickets.map((t) => t.id),
    ];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id.startsWith("DEMO-"))).toBe(true);
  });
  it("prefixes every entity name with DEMO", () => {
    const names = [
      ...m.crm.companies.map((c) => c.name),
      ...m.crm.contacts.map((c) => c.name),
      ...m.crm.deals.map((d) => d.name),
      ...m.billing.customers.map((c) => c.name),
      ...m.support.requesters.map((r) => r.name),
      ...m.support.requesters.map((r) => r.company_name),
      ...m.support.tickets.map((t) => t.subject),
      ...generateSeed().companies.map((c) => c.name),
    ];
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n.startsWith("DEMO "))).toBe(true);
  });
});
