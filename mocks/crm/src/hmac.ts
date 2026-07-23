import { signBody as coreSignBody, secretForSource } from "@switchboard/mock-core";

export { secretForSource } from "@switchboard/mock-core";

// Thin wrapper over @switchboard/mock-core's signBody (where the secret is required):
// this mock IS the CRM source, so defaulting to the CRM secret here is legitimate
// test ergonomics for CRM-specific callers.
export function signBody(rawBody: string, secret: string = secretForSource("crm")): string {
  return coreSignBody(rawBody, secret);
}
