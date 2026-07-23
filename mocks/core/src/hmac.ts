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
// The secret is required here: the generic source app signs with the secret for
// whichever source it is configured as (see source-app.ts).
export function signBody(rawBody: string, secret: string): string {
  const hex = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return `sha256=${hex}`;
}
