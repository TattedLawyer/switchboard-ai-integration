import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { secretForSource, signBody } from "../src/hmac.js";

// A3: signatures are timestamped — the header is t=<seconds>,sha256=<hex> and the
// HMAC covers `${t}.${body}` so the timestamp itself is authenticated.
const T = 1_753_400_000;

describe("signBody", () => {
  it("produces t=<seconds>,sha256=<hex hmac over `t.body`> using the given secret", () => {
    const body = JSON.stringify({ a: 1 });
    const sig = signBody(body, "my-secret", T);
    const expectedHex = createHmac("sha256", "my-secret").update(`${T}.${body}`, "utf8").digest("hex");
    expect(sig).toBe(`t=${T},sha256=${expectedHex}`);
  });

  it("defaults to the CRM per-source secret and the current clock", () => {
    const body = "{}";
    const sig = signBody(body);
    expect(secretForSource("crm")).toBe(process.env.WEBHOOK_SECRET_CRM ?? "demo-secret-crm");
    const t = Number(/^t=(\d+)/.exec(sig)?.[1]);
    expect(Math.abs(t - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(2);
    const expectedHex = createHmac("sha256", secretForSource("crm"))
      .update(`${t}.${body}`, "utf8")
      .digest("hex");
    expect(sig).toBe(`t=${t},sha256=${expectedHex}`);
  });
});
