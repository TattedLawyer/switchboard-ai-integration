// A3: webhook signatures carry a timestamp and are rejected outside a ±300s window.
// Before this wave there was no timestamp, no nonce, no replay bound — a captured valid
// request replayed forever (external audit 2026-07-25, R3). Every major vendor signs a
// timestamp and converges on 5 minutes (Stripe, Slack, HubSpot v3); the timestamp is
// part of the SIGNED material, so an attacker cannot re-stamp a captured signature.
// Within-window replays are absorbed by (source, event_id) idempotent dedup — the
// window bounds how stale a capture can be, dedup handles the rest.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SIGNATURE_TOLERANCE_SECONDS, signBody, verifySignature } from "../src/hmac.js";
import { signBody as mocksSignBody } from "../../mocks/core/src/hmac.js";

const SECRET = "test-secret";
const BODY = '{"hello":"world"}';
const NOW = 1_753_400_000;

describe("A3: signature timestamp + replay window", () => {
  it("header shape carries the signed timestamp: t=<seconds>,sha256=<hex>", () => {
    expect(signBody(BODY, SECRET, NOW)).toMatch(/^t=1753400000,sha256=[0-9a-f]{64}$/);
  });

  it("fresh verifies; boundary holds; stale and far-future are rejected", () => {
    const header = signBody(BODY, SECRET, NOW);
    expect(verifySignature(BODY, header, SECRET, { nowSeconds: NOW })).toBe(true);
    expect(verifySignature(BODY, header, SECRET, { nowSeconds: NOW + 300 })).toBe(true);
    expect(verifySignature(BODY, header, SECRET, { nowSeconds: NOW + 301 })).toBe(false);
    expect(verifySignature(BODY, header, SECRET, { nowSeconds: NOW - 301 })).toBe(false);
  });

  it("the timestamp is inside the signed material: re-stamping a captured header fails", () => {
    const header = signBody(BODY, SECRET, NOW);
    const restamped = header.replace(/^t=\d+/, `t=${NOW + 200}`);
    expect(verifySignature(BODY, restamped, SECRET, { nowSeconds: NOW + 200 })).toBe(false);
  });

  it("legacy timestampless headers are rejected", () => {
    const legacy = `sha256=${createHmac("sha256", SECRET).update(BODY, "utf8").digest("hex")}`;
    expect(verifySignature(BODY, legacy, SECRET, { nowSeconds: NOW })).toBe(false);
  });

  it("garbage timestamps are rejected, never thrown on", () => {
    for (const t of ["t=abc", "t=", "t=1e99", "t=-1"]) {
      const header = `${t},sha256=${"0".repeat(64)}`;
      expect(() => verifySignature(BODY, header, SECRET, { nowSeconds: NOW })).not.toThrow();
      expect(verifySignature(BODY, header, SECRET, { nowSeconds: NOW })).toBe(false);
    }
  });

  it("default tolerance is the 5-minute vendor-consensus window", () => {
    expect(SIGNATURE_TOLERANCE_SECONDS).toBe(300);
  });

  it("signBody defaults to the current clock and round-trips", () => {
    const header = signBody(BODY, SECRET);
    const t = Number(/^t=(\d+)/.exec(header)?.[1]);
    expect(Math.abs(t - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(2);
    expect(verifySignature(BODY, header, SECRET)).toBe(true);
  });

  it("cross-compat: the real MOCK signer's timestamped header verifies under ingest", () => {
    const header = mocksSignBody(BODY, SECRET, NOW);
    expect(verifySignature(BODY, header, SECRET, { nowSeconds: NOW })).toBe(true);
  });
});
