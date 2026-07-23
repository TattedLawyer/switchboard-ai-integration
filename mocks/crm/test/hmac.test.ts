import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { secretForSource, signBody } from "../src/hmac.js";

describe("signBody", () => {
  it("produces sha256=<hex hmac> of the raw body using the given secret", () => {
    const body = JSON.stringify({ a: 1 });
    const sig = signBody(body, "my-secret");
    const expectedHex = createHmac("sha256", "my-secret").update(body, "utf8").digest("hex");
    expect(sig).toBe(`sha256=${expectedHex}`);
  });

  it("defaults to the CRM per-source secret (WEBHOOK_SECRET_CRM env or demo-secret-crm)", () => {
    const body = "{}";
    const sig = signBody(body);
    expect(secretForSource("crm")).toBe(process.env.WEBHOOK_SECRET_CRM ?? "demo-secret-crm");
    const expectedHex = createHmac("sha256", secretForSource("crm"))
      .update(body, "utf8")
      .digest("hex");
    expect(sig).toBe(`sha256=${expectedHex}`);
  });
});
