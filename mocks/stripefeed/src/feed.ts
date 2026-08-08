// The Stripe-STYLE event feed's state: an append-only stream of full-object envelope
// events over the SAME manifest universe as the 2a billing mock (identities correlate),
// with a seeded mock clock and the researched 30-day retrievability window.
//
// Research contract (phase plan §2, Stripe Events / List Events docs, verbatim-verified
// 2026-07-29): events retrievable for 30 days; envelope { id: "evt_…", object: "event",
// type, created: s-epoch, data: { object } }; ids OPAQUE — random per seed, non-ordinal,
// carrying no position information whatsoever. The feed's ledger-equivalent for reconcile
// is its full retained event set: this paradigm has no ledger file and no push channel —
// the feed IS the interface.

import { generateManifest, prng, type Profile } from "@switchboard/mock-core";

export interface FeedEvent {
  id: string;
  object: "event";
  type: string;
  created: number; // SECONDS since epoch (Stripe convention) — not ms
  data: { object: Record<string, unknown> };
}

export interface FeedOptions {
  seed: number;
  /** Vertical profile (F-1): threads to generateManifest like the 2a mocks' opts.profile. */
  profile?: Profile;
  /** Research: "events retrievable for 30 days". Overridable only so tests can pin the
   *  boundary cheaply; the default IS the researched contract. */
  retentionDays?: number;
  /** Honest knob (close F7, the omitStreamIdInStatusFrames precedent): override
   *  amount_cents at named SCRIPT INDICES, for money-bearing slots only. A genuinely
   *  large amount is valid vendor data — the contract's plausibleMax FLAGS it, never
   *  refuses — and the CI fixture uses this to put one above-bound row through the real
   *  connector so the warn surface demonstrably fires instead of passing vacuously.
   *  The BOUND VALUE is the caller's to supply (the fixture derives it from the
   *  contract); this mock types no bound. An index landing on an amount-less slot
   *  (customer.created) refuses loudly at emit — a knob typo must never silently
   *  override nothing. Default absent = byte-identical stream. */
  amountCentsAt?: Readonly<Record<number, number>>;
}

export interface FeedState {
  /** Emit `count` new events at the mock clock's now (optionally aged into the past —
   *  how tests seed history that can later fall off the retention cliff). */
  emit(count: number, opts?: { ageS?: number }): FeedEvent[];
  /** Advance the mock clock — the only way time passes here. Seeded determinism holds
   *  because the clock's BASE is captured once at creation. */
  advance(seconds: number): void;
  nowS(): number;
  /** The full retained set, in emission order — the reconcile truth. */
  retained(): FeedEvent[];
  /** Emission count over the process lifetime (the /status seq). */
  seq(): number;
  /** One page as the vendor contract defines it. `startingAfter: null` = from the start
   *  of the retained window. Throws UnknownCursorError for an id not in the retained set
   *  — aged-out and never-existed are indistinguishable, by design. */
  page(startingAfter: string | null, limit: number): { data: FeedEvent[]; has_more: boolean };
}

/** An id the retained window does not contain. The HTTP layer maps this to the
 *  documented 400 resource_missing shape. */
export class UnknownCursorError extends Error {
  constructor(readonly id: string) {
    super(`No such event: '${id}'`);
  }
}

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const pad = (n: number) => String(n).padStart(4, "0");

export function createFeed(opts: FeedOptions): FeedState {
  const retentionS = (opts.retentionDays ?? 30) * 86_400;
  const { customers, invoices } = generateManifest(opts.seed, opts.profile).billing;

  // Two independent seeded streams so id minting never perturbs anything else.
  const idRand = prng(opts.seed ^ 0x5f3759df);
  const mintedIds = new Set<string>();
  const mintId = (): string => {
    // Opaque, non-ordinal, unique: 24 seeded base36 chars; re-draw on the (astronomically
    // unlikely) collision so uniqueness is a property, not a probability.
    for (;;) {
      let id = "evt_";
      for (let i = 0; i < 24; i++) id += ID_ALPHABET[Math.floor(idRand() * ID_ALPHABET.length)];
      if (!mintedIds.has(id)) {
        mintedIds.add(id);
        return id;
      }
    }
  };

  // Mock clock: real boot instant + an offset tests advance. Emitted `created` values are
  // therefore REAL past timestamps unless the clock has been advanced — which keeps the
  // ingest door's occurred_at window gate honest in oracle tests.
  const bootS = Math.floor(Date.now() / 1000);
  let offsetS = 0;

  // 4-slot script cycle over the shared universe: every cycle touches all four event
  // types. Charge ids are minted deterministically per cycle (DEMO-CH-…), the same
  // construction discipline as the 2a billing mock's DEMO-PAY-… payments.
  let emitted = 0;
  const script = (i: number): { type: string; object: Record<string, unknown> } => {
    const n = Math.floor(i / 4);
    const inv = invoices[n % invoices.length];
    const override = opts.amountCentsAt?.[i];
    const withOverride = (object: Record<string, unknown>): Record<string, unknown> =>
      override === undefined ? object : { ...object, amount_cents: override };
    switch (i % 4) {
      case 0:
        if (override !== undefined) {
          throw new Error(
            `amountCentsAt[${i}] targets a customer.created slot (i % 4 === 0), which carries no ` +
              "amount_cents — the override would silently apply to nothing. Pick an invoice/charge index.",
          );
        }
        return { type: "customer.created", object: { ...customers[n % customers.length], object: "customer" } };
      case 1:
        return { type: "invoice.finalized", object: withOverride({ ...inv, object: "invoice" }) };
      case 2:
        return {
          type: "charge.succeeded",
          object: withOverride({ id: `DEMO-CH-${pad(n * 2 + 1)}`, object: "charge", invoice_id: inv.id, customer_id: inv.customer_id, amount_cents: inv.amount_cents, currency: inv.currency }),
        };
      default:
        return {
          type: "charge.failed",
          object: withOverride({ id: `DEMO-CH-${pad(n * 2 + 2)}`, object: "charge", invoice_id: inv.id, customer_id: inv.customer_id, amount_cents: inv.amount_cents, currency: inv.currency }),
        };
    }
  };

  const events: FeedEvent[] = [];
  const nowS = () => bootS + offsetS;

  const emit = (count: number, emitOpts?: { ageS?: number }): FeedEvent[] => {
    const created = nowS() - (emitOpts?.ageS ?? 0);
    const last = events.at(-1);
    if (last !== undefined && created < last.created) {
      throw new Error(
        `feed refuses emission: created would regress (${created} < ${last.created}) — ` +
          "the stream appends; history never interleaves. Emit aged batches first.",
      );
    }
    const batch: FeedEvent[] = [];
    for (let i = 0; i < count; i++) {
      const { type, object } = script(emitted++);
      batch.push({ id: mintId(), object: "event", type, created, data: { object } });
    }
    events.push(...batch);
    return batch;
  };

  const retained = (): FeedEvent[] => events.filter((e) => nowS() - e.created <= retentionS);

  const page = (startingAfter: string | null, limit: number) => {
    const window = retained();
    let start = 0;
    if (startingAfter !== null) {
      const idx = window.findIndex((e) => e.id === startingAfter);
      if (idx === -1) throw new UnknownCursorError(startingAfter);
      start = idx + 1;
    }
    return { data: window.slice(start, start + limit), has_more: start + limit < window.length };
  };

  return {
    emit,
    advance: (seconds: number) => {
      offsetS += seconds;
    },
    nowS,
    retained,
    seq: () => emitted,
    page,
  };
}
