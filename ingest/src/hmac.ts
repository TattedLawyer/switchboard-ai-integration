import { createHmac, timingSafeEqual } from "node:crypto";
import type { Source } from "./sources.js";

// Per-source webhook secrets (D3): WEBHOOK_SECRET_CRM / _BILLING / _SUPPORT.
// FAIL CLOSED (A2): the demo defaults are published in this public repo, so falling
// back to them silently would make a misconfigured production deploy authenticate
// forged webhooks against a string anyone can read (CWE-1188/CWE-798). Local demo use
// opts in explicitly with ALLOW_DEV_SECRETS=1 (demo.sh/chaos.sh and the test configs
// set it; nothing else should).
// NOTE: secretForSource is intentionally duplicated in mocks (separate workspaces,
// must not cross-import). Keep copies in sync. The parameter is typed as Source so
// the registry gate is structural: ingest code cannot derive a secret for a source
// the registry does not know about.
export function devSecretsAllowed(): boolean {
  return process.env.ALLOW_DEV_SECRETS === "1";
}

export function secretForSource(source: Source): string {
  const name = `WEBHOOK_SECRET_${source.toUpperCase()}`;
  const env = process.env[name];
  if (env) return env;
  if (devSecretsAllowed()) return `demo-secret-${source}`;
  throw new Error(
    `${name} is not set — refusing to fall back to the published demo secret. ` +
      `Set ${name}, or set ALLOW_DEV_SECRETS=1 for local demo use only.`,
  );
}

// Boot-time assertion: one aggregated error naming every missing secret, so an operator
// fixes the deploy once instead of discovering variables one crash at a time.
export function assertWebhookSecrets(sources: readonly Source[]): void {
  if (devSecretsAllowed()) return;
  const missing = sources
    .map((s) => `WEBHOOK_SECRET_${s.toUpperCase()}`)
    .filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `missing required secrets: ${missing.join(", ")} — set them, ` +
        `or set ALLOW_DEV_SECRETS=1 for local demo use only.`,
    );
  }
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
