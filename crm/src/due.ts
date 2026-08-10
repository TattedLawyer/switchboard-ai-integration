// When a contact next comes due, and for how long a proposer may hold a claim.
//
// 🚨 TWO DIFFERENT CLOCKS, AND CONFLATING THEM IS THE BUG THIS FILE EXISTS TO PREVENT.
//
//   · THE CLAIM LEASE is 15 minutes. It stops a SECOND PROPOSER for the length of one
//     cycle. It is NOT a reschedule, and an implementer who reached for the follow-up
//     interval in the claim statement would push a BLOCKED contact 30 days into the future
//     for the crime of having been claimed — which is the failure the whole product exists
//     to fix, caused by us. A crashed cycle costs fifteen minutes, not an interval.
//   · THE FOLLOW-UP INTERVAL is hers, and `recordTouch` is the ONLY thing that ever writes
//     it.
//
// The lease is a constant, not a tenant setting: nobody has an opinion about it and it is
// not a tuning knob. It lives here rather than in a SQL function because 015:509-518 forbids
// this repo's migrations from creating callable SQL functions (created `proacl` NULL, i.e.
// PUBLIC-executable by default).
export const CLAIM_LEASE_MINUTES = 15;

export interface IntervalInputs {
  /** `crm.contacts.follow_up_interval_days` — NULL means "use hers". */
  contactIntervalDays: number | null;
  /** `crm.outreach_settings.default_interval_days`. No default exists; she set it. */
  tenantDefaultDays: number;
}

/**
 * The long interval for a contact, resolved AT DUE-COMPUTATION TIME.
 *
 * 🚨 THE RESOLUTION MUST NOT HAPPEN AT INSERT. Backfilling the tenant default into
 * `contacts.follow_up_interval_days` at capture time freezes today's setting into the row,
 * so a later change to her default silently stops applying to everyone captured before it —
 * a setting that appears to work and does not. NULL means "hers, whatever it is now".
 */
export function resolveIntervalDays(i: IntervalInputs): number {
  return i.contactIntervalDays ?? i.tenantDefaultDays;
}

export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 86_400_000);
}
