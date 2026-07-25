import { createHmac } from "node:crypto";

// Per-source webhook secrets (D3): WEBHOOK_SECRET_CRM / _BILLING / _SUPPORT.
// FAIL CLOSED (A2): the demo defaults are published in this public repo; a writer that
// silently signs with them would let a misconfigured deploy authenticate forged traffic
// (CWE-1188/CWE-798). Local demo use opts in with ALLOW_DEV_SECRETS=1.
// NOTE: secretForSource is intentionally duplicated in ingest/src/hmac.ts (separate
// workspaces, must not cross-import). Keep copies in sync.
export function secretForSource(source: string): string {
  const name = `WEBHOOK_SECRET_${source.toUpperCase()}`;
  const env = process.env[name];
  if (env) return env;
  if (process.env.ALLOW_DEV_SECRETS === "1") return `demo-secret-${source}`;
  throw new Error(
    `${name} is not set — refusing to fall back to the published demo secret. ` +
      `Set ${name}, or set ALLOW_DEV_SECRETS=1 for local demo use only.`,
  );
}

// NOTE: signBody is intentionally duplicated in ingest/src/hmac.ts (separate workspace,
// must not cross-import). Keep both copies in sync if the signing scheme changes.
// The secret is required here: the generic source app signs with the secret for
// whichever source it is configured as (see source-app.ts).
export function signBody(rawBody: string, secret: string): string {
  const hex = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return `sha256=${hex}`;
}
