import { createHmac } from "node:crypto";

// Shared secret for signing/verifying webhook deliveries. Demo-only default — real deployments
// must set WEBHOOK_SECRET to a proper secret.
export const DEFAULT_WEBHOOK_SECRET = "demo-secret";

export function signBody(rawBody: string, secret: string = process.env.WEBHOOK_SECRET ?? DEFAULT_WEBHOOK_SECRET): string {
  const hex = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return `sha256=${hex}`;
}
