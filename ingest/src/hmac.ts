import { createHmac, timingSafeEqual } from "node:crypto";

// Per-source webhook secrets (D3): WEBHOOK_SECRET_CRM / _BILLING / _SUPPORT.
// Demo-only defaults, printed in the open — real deployments must set proper secrets.
// NOTE: secretForSource is intentionally duplicated in mocks (separate workspaces,
// must not cross-import). Keep copies in sync.
export function secretForSource(source: string): string {
  return process.env[`WEBHOOK_SECRET_${source.toUpperCase()}`] ?? `demo-secret-${source}`;
}

// NOTE: signBody is intentionally duplicated in mocks/crm/src/hmac.ts (separate
// workspace, must not cross-import). Keep both copies in sync if the signing scheme
// changes. The default secret mirrors the mock side's default (it signs as "crm").
export function signBody(rawBody: string, secret: string = secretForSource("crm")): string {
  const hex = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return `sha256=${hex}`;
}

export function verifySignature(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = signBody(rawBody, secret);
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(header, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
