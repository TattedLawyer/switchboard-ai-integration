import { createHmac } from "node:crypto";

// Per-source webhook secrets (D3): WEBHOOK_SECRET_CRM / _BILLING / _SUPPORT.
// Demo-only defaults, printed in the open — real deployments must set proper secrets.
// NOTE: secretForSource is intentionally duplicated in ingest/src/hmac.ts (separate
// workspaces, must not cross-import). Keep copies in sync.
export function secretForSource(source: string): string {
  return process.env[`WEBHOOK_SECRET_${source.toUpperCase()}`] ?? `demo-secret-${source}`;
}

// NOTE: signBody is intentionally duplicated in ingest/src/hmac.ts (separate workspace,
// must not cross-import). Keep both copies in sync if the signing scheme changes.
// This mock is the CRM source, so it signs with the CRM secret by default.
export function signBody(rawBody: string, secret: string = secretForSource("crm")): string {
  const hex = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return `sha256=${hex}`;
}
