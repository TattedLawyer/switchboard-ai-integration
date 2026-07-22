import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDbtSchema } from "../src/host/schema.js";

const ORIGINAL = process.env.DBT_SCHEMA;

beforeEach(() => {
  delete process.env.DBT_SCHEMA;
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DBT_SCHEMA;
  else process.env.DBT_SCHEMA = ORIGINAL;
});

describe("readDbtSchema", () => {
  it("defaults to public_analytics when unset", () => {
    expect(readDbtSchema()).toBe("public_analytics");
  });

  it("accepts a valid lowercase identifier", () => {
    process.env.DBT_SCHEMA = "my_schema_2";
    expect(readDbtSchema()).toBe("my_schema_2");
  });

  it("rejects an identifier containing SQL injection attempt", () => {
    process.env.DBT_SCHEMA = "public; drop table users;--";
    expect(() => readDbtSchema()).toThrow(/invalid DBT_SCHEMA/);
  });

  it("rejects an identifier with a quote/space", () => {
    process.env.DBT_SCHEMA = "bad schema";
    expect(() => readDbtSchema()).toThrow(/invalid DBT_SCHEMA/);
  });

  it("rejects an identifier starting with a digit", () => {
    process.env.DBT_SCHEMA = "1bad";
    expect(() => readDbtSchema()).toThrow(/invalid DBT_SCHEMA/);
  });
});
