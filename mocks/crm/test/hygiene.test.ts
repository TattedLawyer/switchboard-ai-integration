import { describe, expect, it } from "vitest";
import { generateSeed } from "../src/seed.js";

describe("fixture hygiene", () => {
  const blob = JSON.stringify(generateSeed());
  it("uses only example.com emails", () => {
    const emails = blob.match(/[\w.+-]+@[\w.-]+/g) ?? [];
    expect(emails.length).toBeGreaterThan(0);
    expect(emails.every((e) => e.endsWith("@example.com"))).toBe(true);
  });
  it("contains no SSN- or US-phone-shaped strings", () => {
    expect(blob).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
    expect(blob).not.toMatch(/\b\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/);
  });
  it("prefixes every entity name with DEMO", () => {
    const { companies } = generateSeed();
    expect(companies.every((c) => c.name.startsWith("DEMO "))).toBe(true);
  });
});
