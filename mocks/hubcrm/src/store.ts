// The HubSpot-STYLE thin-webhook CRM's state: an object store (the paradigm's
// ledger-equivalent — reconcile truth is the store's CURRENT state, not an event log),
// a deterministic mutation script over the shared manifest universe, and a batched
// webhook delivery channel whose events are METADATA-ONLY by design (phase plan §2).
//
// RED stub (Task C pair 2): surface only; implementation lands in the GREEN commit.

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

export function createHubStore(_opts: HubStoreOptions): HubStore {
  throw new Error("not implemented (Task C pair 2 RED)");
}
