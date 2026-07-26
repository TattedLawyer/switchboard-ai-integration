import { describe, expect, it } from "vitest";
import { generateSeed } from "../src/seed.js";

describe("generateSeed", () => {
  it("is deterministic for the same seed", () => {
    expect(generateSeed(42)).toEqual(generateSeed(42));
  });
  it("produces 22 companies, 40 contacts, and 60 deals with DEMO- ids", () => {
    const { companies, contacts, deals } = generateSeed();
    expect(companies).toHaveLength(22);
    expect(contacts).toHaveLength(40);
    expect(deals).toHaveLength(60);
    expect(companies.every((c) => c.id.startsWith("DEMO-C-"))).toBe(true);
    expect(contacts.every((c) => c.id.startsWith("DEMO-P-"))).toBe(true);
    expect(deals.every((d) => d.id.startsWith("DEMO-D-"))).toBe(true);
  });
  it("links every deal to an existing company", () => {
    const { companies, deals } = generateSeed();
    const ids = new Set(companies.map((c) => c.id));
    expect(ids.size).toBe(22);
    expect(deals.every((d) => ids.has(d.company_id))).toBe(true);
  });
});
