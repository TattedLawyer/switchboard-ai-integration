import { createHmac, timingSafeEqual } from "node:crypto";
import type { Source } from "./sources.js";

// Per-source webhook secrets (D3): WEBHOOK_SECRET_CRM / _BILLING / _SUPPORT.
// Demo-only defaults, printed in the open — real deployments must set proper secrets.
// NOTE: secretForSource is intentionally duplicated in mocks (separate workspaces,
// must not cross-import). Keep copies in sync. The parameter is typed as Source so
// the registry gate is structural: ingest code cannot derive a secret for a source
// the registry does not know about.
export function secretForSource(source: Source): string {
  return process.env[`WEBHOOK_SECRET_${source.toUpperCase()}`] ?? `demo-secret-${source}`;
}

// NOTE: signBody is intentionally duplicated in mocks/core/src/hmac.ts (separate
// workspace, must not cross-import). Keep both copies in sync if the signing scheme
// changes. The secret is REQUIRED on the ingest side — callers must say which
// source's secret they are signing with.
export function signBody(rawBody: string, secret: string): string {
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
