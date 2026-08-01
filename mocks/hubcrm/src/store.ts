// The HubSpot-STYLE thin-webhook CRM's state: an object store (the paradigm's
// ledger-equivalent — reconcile truth is the store's CURRENT state, not an event log),
// a deterministic mutation script over the shared manifest universe, and a batched
// webhook delivery channel whose events are METADATA-ONLY by design (phase plan §2,
// verbatim-verified 2026-07-29): `objectId`, `propertyName`/`propertyValue` only on
// property-change subscriptions (ONE property per event), `eventId`, `subscriptionType`,
// `portalId`, `occurredAt` ms-epoch, `attemptNumber` from 0, `changeSource`; requests
// carry up to 100 events; ordering NOT guaranteed. The full record is reachable only
// through the hydration API (server.ts), which serves FETCH-time state.

import { generateManifest, prng, secretForSource, signBody, type Profile } from "@switchboard/mock-core";

export type HubObjectType = "company" | "contact" | "deal";

/** The researched thin-event field set — verbatim vendor vocabulary, camelCase and all:
 *  these objects ARE the wire payload elements, stored in raw exactly as received (D7). */
export interface ThinEvent {
  eventId: number;
  subscriptionType: string; // "<objectType>.creation|propertyChange|deletion"
  portalId: number;
  occurredAt: number; // ms epoch (HubSpot convention — NOT seconds)
  objectId: number;
  /** Property-change events only — ONE property per event, sparse by design. */
  propertyName?: string;
  /** null = the property was CLEARED ("no value now", not garbage). */
  propertyValue?: string | null;
  changeSource: string;
  attemptNumber: number; // 0 on first delivery; re-deliveries increment
}

/** A full record as the hydration API serves it: vendor-faithful string properties. */
export interface HubRecord {
  objectId: number;
  objectType: HubObjectType;
  properties: Record<string, string | null>;
}

export interface HubFaultPlan {
  seed: number;
  /** Never delivered at all — the 10-retries-exhausted permanent webhook loss. */
  dropRate?: number;
  /** Re-delivered in a later request with attemptNumber+1. */
  dupRate?: number;
  /** Deferred to a later batch — cross-batch out-of-order. */
  holdoverRate?: number;
  /** Seeded Fisher–Yates within each batch — within-batch out-of-order. */
  shuffleWithinBatch?: boolean;
}

export interface DeliveryStats {
  batches: number;
  delivered: number;
  dropped: number;
  duplicated: number;
  heldOver: number;
  redeliveries: number;
  /** Batches abandoned after the retry budget — their events are LOST (paradigm-honest). */
  failedBatches: number;
}

export interface DeliverOptions {
  webhookUrl: string;
  batchSize?: number; // ≤100, the vendor cap
  faultPlan?: HubFaultPlan;
  redeliverAttempts?: number;
}

export interface HubStoreOptions {
  seed: number;
  portalId?: number;
  /** Vertical profile (F-1): threads to generateManifest exactly like the 2a mocks'
   *  opts.profile — the SHARED-universe premise holds only if every mock in a stack
   *  derives from the same (seed, profile). Unknown names refuse at construction. */
  profile?: Profile;
}

export interface HubStore {
  /** Run `count` deterministic script ops (creates, one-property changes incl. a currency
   *  CLEAR, deletions); emitted events queue as pending until deliver(). */
  simulate(count: number): ThinEvent[];
  pending(): ThinEvent[];
  deliver(opts: DeliverOptions): Promise<DeliveryStats>;
  get(type: HubObjectType, objectId: number): HubRecord | undefined;
  list(type: HubObjectType): HubRecord[];
  allObjects(): HubRecord[];
  /** Full emission history including dropped events — test/oracle accounting. */
  emittedEvents(): ThinEvent[];
  seq(): number;
}

const CHANGE_SOURCES = ["CRM_UI", "API", "IMPORT"];

export function createHubStore(opts: HubStoreOptions): HubStore {
  const portalId = opts.portalId ?? 24_000_000 + (opts.seed % 1000);
  const manifest = generateManifest(opts.seed, opts.profile).crm; // the SHARED universe — identities correlate with the 2a mocks at the same (seed, profile)
  const idRand = prng(opts.seed ^ 0x9e3779b9);
  const mintedIds = new Set<number>();
  /** Non-ordinal numeric ids (HubSpot eventIds/objectIds are int64-ish): random draws
   *  from a seeded stream carry no position information. Redraw on collision so
   *  uniqueness is a property, not a probability. */
  const mintId = (): number => {
    for (;;) {
      const id = 1_000_000_000 + Math.floor(idRand() * 8_999_999_999);
      if (!mintedIds.has(id)) {
        mintedIds.add(id);
        return id;
      }
    }
  };

  const store: Record<HubObjectType, Map<number, HubRecord>> = {
    company: new Map(),
    contact: new Map(),
    deal: new Map(),
  };
  const emitted: ThinEvent[] = [];
  let pendingQueue: ThinEvent[] = [];
  let ops = 0;
  let createdCompanies = 0;
  let createdContacts = 0;
  let createdDeals = 0;
  let revs = 0;

  const emit = (
    subscriptionType: string,
    objectId: number,
    prop?: { name: string; value: string | null },
  ): ThinEvent => {
    const event: ThinEvent = {
      eventId: mintId(),
      subscriptionType,
      portalId,
      occurredAt: Date.now(),
      objectId,
      ...(prop === undefined ? {} : { propertyName: prop.name, propertyValue: prop.value }),
      changeSource: CHANGE_SOURCES[ops % CHANGE_SOURCES.length],
      attemptNumber: 0,
    };
    emitted.push(event);
    pendingQueue.push(event);
    return event;
  };

  const createObject = (type: HubObjectType): ThinEvent => {
    const objectId = mintId();
    let properties: Record<string, string | null>;
    if (type === "company") {
      const c = manifest.companies[createdCompanies++ % manifest.companies.length];
      properties = { name: c.name, domain: c.domain, owner_email: c.owner_email, hs_manifest_id: c.id };
    } else if (type === "contact") {
      const c = manifest.contacts[createdContacts++ % manifest.contacts.length];
      properties = { name: c.name, email: c.email, company_manifest_id: c.company_id, hs_manifest_id: c.id };
    } else {
      const d = manifest.deals[createdDeals++ % manifest.deals.length];
      properties = {
        name: d.name,
        amount_cents: String(d.amount_cents),
        currency: d.currency,
        status: d.status,
        company_manifest_id: d.company_id,
        hs_manifest_id: d.id,
      };
    }
    store[type].set(objectId, { objectId, objectType: type, properties });
    return emit(`${type}.creation`, objectId);
  };

  /** Deterministic round-robin target among live objects of a type. */
  const target = (type: HubObjectType): HubRecord | undefined => {
    const live = [...store[type].values()];
    if (live.length === 0) return undefined;
    return live[Math.floor(ops / 10) % live.length];
  };

  const change = (type: HubObjectType, rec: HubRecord, name: string, value: string | null): ThinEvent => {
    rec.properties[name] = value;
    return emit(`${type}.propertyChange`, rec.objectId, { name, value });
  };

  /** The 10-op script cycle. Slot 8 creates a deal and slot 9 deletes it — the
   *  creation event's hydration meets a 404 (deleted-before-fetch, the tombstone
   *  scenario) whenever both land in the same delivery run. Slot 7 CLEARS a deal's
   *  currency (propertyValue null) so the sparse-null decision is exercised by every
   *  seeded run, never only by a bespoke test. */
  let lastSlot8Deal: number | null = null;
  const step = (): ThinEvent[] => {
    const i = ops++;
    const out: ThinEvent[] = [];
    switch (i % 10) {
      case 0:
        out.push(createObject("company"));
        break;
      case 1:
        out.push(createObject("contact"));
        break;
      case 2:
        out.push(createObject("deal"));
        break;
      case 3: {
        const d = target("deal");
        out.push(d ? change("deal", d, "amount_cents", String(50_000 + ((i * 7919) % 4_000_000))) : createObject("deal"));
        break;
      }
      case 4: {
        const c = target("company");
        if (c) {
          const base = String(c.properties.name).split(" Rev ")[0];
          out.push(change("company", c, "name", `${base} Rev ${++revs}`));
        } else out.push(createObject("company"));
        break;
      }
      case 5: {
        const d = target("deal");
        out.push(d ? change("deal", d, "status", i % 20 === 5 ? "won" : "open") : createObject("deal"));
        break;
      }
      case 6: {
        const c = target("contact");
        if (c) {
          const addr = String(c.properties.email);
          out.push(change("contact", c, "email", addr.replace(/^/, `r${(i % 97)}.`)));
        } else out.push(createObject("contact"));
        break;
      }
      case 7: {
        const d = target("deal");
        out.push(d ? change("deal", d, "currency", null) : createObject("deal"));
        break;
      }
      case 8: {
        const e = createObject("deal");
        lastSlot8Deal = e.objectId;
        out.push(e);
        break;
      }
      case 9: {
        if (lastSlot8Deal !== null && store.deal.has(lastSlot8Deal)) {
          store.deal.delete(lastSlot8Deal);
          out.push(emit("deal.deletion", lastSlot8Deal));
          lastSlot8Deal = null;
        } else {
          out.push(createObject("deal"));
        }
        break;
      }
    }
    return out;
  };

  const deliver = async (deliverOpts: DeliverOptions): Promise<DeliveryStats> => {
    const batchSize = deliverOpts.batchSize ?? 100;
    if (batchSize < 1 || batchSize > 100) {
      throw new Error(`batchSize ${batchSize} out of range: HubSpot requests carry at most 100 events`);
    }
    const redeliverAttempts = deliverOpts.redeliverAttempts ?? 0;
    const plan = deliverOpts.faultPlan;
    const rand = plan ? prng(plan.seed) : null;
    const draw = () => (rand === null ? 1 : rand());

    const stats: DeliveryStats = {
      batches: 0,
      delivered: 0,
      dropped: 0,
      duplicated: 0,
      heldOver: 0,
      redeliveries: 0,
      failedBatches: 0,
    };

    // Fault pass over the emission-ordered queue: drops leave, holdovers move to the
    // tail (cross-batch disorder), duplicates append a copy at the tail with
    // attemptNumber+1 (a later REQUEST re-delivers the same eventId).
    const queue: ThinEvent[] = [];
    const tail: ThinEvent[] = [];
    for (const e of pendingQueue) {
      if (plan?.dropRate && draw() < plan.dropRate) {
        stats.dropped++;
        continue;
      }
      if (plan?.holdoverRate && draw() < plan.holdoverRate) {
        stats.heldOver++;
        tail.push(e);
        continue;
      }
      queue.push(e);
      if (plan?.dupRate && draw() < plan.dupRate) {
        stats.duplicated++;
        tail.push({ ...e, attemptNumber: e.attemptNumber + 1 });
      }
    }
    queue.push(...tail);
    pendingQueue = [];

    for (let start = 0; start < queue.length; start += batchSize) {
      let batch = queue.slice(start, start + batchSize);
      if (plan?.shuffleWithinBatch && rand !== null) {
        batch = [...batch];
        for (let i = batch.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [batch[i], batch[j]] = [batch[j], batch[i]];
        }
      }

      // The request IS the retry unit (HubSpot re-sends the whole delivery): on a
      // non-2xx answer the SAME batch goes again with attemptNumber+1 on every event,
      // up to the budget; an exhausted budget abandons the batch — that loss is the
      // paradigm's own (10 retries over 24h, then gone).
      let sent = batch;
      let ok = false;
      for (let attempt = 0; attempt <= redeliverAttempts; attempt++) {
        if (attempt > 0) {
          sent = sent.map((e) => ({ ...e, attemptNumber: e.attemptNumber + 1 }));
          stats.redeliveries++;
        }
        const body = JSON.stringify(sent);
        try {
          const res = await fetch(deliverOpts.webhookUrl, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-switchboard-signature": signBody(body, secretForSource("hubcrm")),
            },
            body,
          });
          if (res.ok) {
            ok = true;
            break;
          }
        } catch {
          // connection failure counts against the same retry budget
        }
      }
      stats.batches++;
      if (ok) stats.delivered += sent.length;
      else stats.failedBatches++;
    }
    return stats;
  };

  return {
    simulate: (count: number): ThinEvent[] => {
      const out: ThinEvent[] = [];
      for (let i = 0; i < count; i++) out.push(...step());
      return out;
    },
    pending: () => [...pendingQueue],
    deliver,
    get: (type, objectId) => store[type].get(objectId),
    list: (type) => [...store[type].values()],
    allObjects: () => [...store.company.values(), ...store.contact.values(), ...store.deal.values()],
    emittedEvents: () => [...emitted],
    seq: () => emitted.length,
  };
}
