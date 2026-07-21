import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { signBody } from "../src/hmac.js";

describe("signBody", () => {
  it("produces sha256=<hex hmac> of the raw body using the given secret", () => {
    const body = JSON.stringify({ a: 1 });
    const sig = signBody(body, "my-secret");
    const expectedHex = createHmac("sha256", "my-secret").update(body, "utf8").digest("hex");
    expect(sig).toBe(`sha256=${expectedHex}`);
  });

  it("defaults to WEBHOOK_SECRET env or demo-secret", () => {
    const body = "{}";
    const sig = signBody(body);
    const expectedHex = createHmac("sha256", process.env.WEBHOOK_SECRET ?? "demo-secret")
      .update(body, "utf8")
      .digest("hex");
    expect(sig).toBe(`sha256=${expectedHex}`);
  });
});
