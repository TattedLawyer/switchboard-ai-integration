import { createHmac, timingSafeEqual } from "node:crypto";

// NOTE: DEFAULT_WEBHOOK_SECRET and signBody are intentionally duplicated in
// mocks/crm/src/hmac.ts (separate workspace, must not cross-import). Keep both copies
// in sync if the secret or signing scheme changes.
// Demo-only default secret — real deployments must set WEBHOOK_SECRET.
export const DEFAULT_WEBHOOK_SECRET = "demo-secret";

export function signBody(rawBody: string, secret: string = process.env.WEBHOOK_SECRET ?? DEFAULT_WEBHOOK_SECRET): string {
  const hex = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return `sha256=${hex}`;
}

export function verifySignature(
  rawBody: string,
  header: string | undefined,
  secret: string = process.env.WEBHOOK_SECRET ?? DEFAULT_WEBHOOK_SECRET,
): boolean {
  if (!header) return false;
  const expected = signBody(rawBody, secret);
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(header, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
