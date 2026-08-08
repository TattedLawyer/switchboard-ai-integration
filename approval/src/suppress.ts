// Phase 3 / A2 — repeat suppression, and the two rules it has to obey at once.
//
// THE MEASURED GROUND. Ancker et al. 2017 (1,266,325 advisories, 326,203 drug alerts,
// 430,803 encounters): each ADDITIONAL advisory within one work unit cut acceptance 30%
// (IRR 0.70, p<.001), and each 5pp rise in the share that are REPEATS cut it 10%
// (IRR 0.90, p<.001) — with repeat-suppression the authors' own recommended lever. Also
// measured, and worth stating because both are folk beliefs otherwise: there is NO general
// workload effect and NO desensitisation over time. "She is busy" and "she'll go numb" are
// affirmatively not the mechanism.
//
// SO THERE ARE TWO RULES, AND EARLIER REVISIONS OF THIS DESIGN ONLY ENFORCED ONE:
//   · NEVER SPLIT ONE OUTCOME ACROSS SEVERAL CARDS  (the 1:1 discipline)
//   · NEVER MERGE TWO OUTCOMES INTO ONE CARD        (this file)
//
// 🚨 WHY THE KEY IS THE PAYLOAD HASH AND NOTHING CLEVERER. An earlier key was
// `(action_type, normalised recipient set, resolved entity)`, defended by asymmetry: "a
// mis-normalised address produces a DUPLICATE card, so it fails toward asking the human."
// That analysed only over-SPLITTING. Over-COLLAPSING is the direction such a key is
// DESIGNED to produce, and it kills people's asks:
//
//     send_email to jane@client.example.com — "your listing expires Friday"
//     send_email to jane@client.example.com — "we are dropping the price to $400,000"
//
// Same action type, same recipient, same entity — same key — SUPPRESSED. Either the price
// drop is silently discarded, or two rows hide behind one card and an implementer resolves
// it the obvious way (approve the OUTCOME, not the row) and sends an email the human never
// read. Keying on the payload hash closes that direction BY CONSTRUCTION rather than by
// argument: two different messages cannot share a key because they cannot share a hash.
//
// AND `rationale` IS IN THE KEY. Without it, the identical email proposed twice with
// rationales "routine follow-up" and "client called; she is threatening to list elsewhere"
// renders as ONE card showing the earlier reason, and the one that would have changed her
// deliberation is superseded unseen. No unapproved send results — the payload is identical
// and at-most-once holds — but the card must carry everything decision-relevant on its
// face, and `rationale` is serious enough to be an injection boundary in its own right.
// Adding it to the key can ONLY EVER SPLIT, which is the safe direction, and it costs one
// column in a hash input.
//
// WHAT THIS TRADE COSTS, named rather than smoothed: suppression now fires ONLY on
// byte-identical repeats. A near-duplicate — one word changed, or a regenerated timestamp
// inside the payload — produces two cards. That is a real loss, because repetition is the
// evidence-backed driver of dismissal and we have deliberately weakened the
// strongest-supported volume control in the design. It is the right trade: the failure it
// buys is "she sees two similar cards" — visible, annoying, self-reporting — and the
// failure it avoids is "she never sees the price drop she needed to authorise" — invisible,
// and discovered only when a client acts on something she never approved.
//
// 🚨 IF NEAR-DUPLICATE VOLUME EVER BECOMES A REAL PROBLEM, THE ANSWER IS TO NARROW THE
// ACTION SO THE AGENT STOPS GENERATING THEM. Never a fuzzier key. A fuzzy key is this
// defect returning.
//
// 🚨 AND SUPPRESSION IS A RENDER-TIME DEDUP, NEVER A DOOR-TIME REJECTION. NO PROPOSAL IS
// EVER DISCARDED WITHOUT A HUMAN SEEING IT ONCE. Every row is written; the collapse happens
// when the queue is drawn, and the rows it did not surface are disposed of explicitly.
import type pg from "pg";
import { decideOn } from "./decide.js";
import { transition } from "./transition.js";
import type { QueueRow } from "./queue.js";

/** The suppression key. `(action_type, payload_hash, rationale)` — nothing else. There is
 *  deliberately no recipient in it: A2 parses recipients NOWHERE, which retires an entire
 *  defect class (address normalisation, case folding, homoglyphs, and a second parser for
 *  C5's executor to disagree with) along with the field that invited it. */
export function suppressionKey(row: {
  action_type: string;
  payload_hash: string;
  rationale: string;
}): string {
  return JSON.stringify([row.action_type, row.payload_hash, row.rationale]);
}

export interface CollapsedCard {
  /** The row the card represents and the one an approval acts on: the EARLIEST, by the
   *  read model's `created_at, id` order. */
  primary: QueueRow;
  /** The byte-identical repeats behind it. Empty for the ordinary case. */
  duplicates: QueueRow[];
}

/**
 * Group a queue into cards. Input must already be ordered `created_at, id` — that ordering
 * is what makes "the earliest row" deterministic when two proposals share a transaction
 * start, so which row a card ACTS ON is stable rather than plan-dependent. (An earlier
 * version of this sentence said the `supersedes` GRAPH depends on it. It does not:
 * collapse writes no `supersedes` link and cannot, because the column is frozen. What
 * depends on the ordering is which row gets approved and which get superseded — and that
 * is what an auditor reconstructs, from the shared suppression key.)
 */
export function collapseDuplicates(rows: readonly QueueRow[]): CollapsedCard[] {
  const cards = new Map<string, CollapsedCard>();
  for (const row of rows) {
    const key = suppressionKey(row);
    const existing = cards.get(key);
    if (existing === undefined) cards.set(key, { primary: row, duplicates: [] });
    else existing.duplicates.push(row);
  }
  return [...cards.values()];
}

/**
 * Approve a card: approve the primary, and dispose of the repeats as `superseded`.
 *
 * `superseded` rather than `approved` for the repeats, because approving them would be
 * approving the same outcome N times and at-most-once already holds per row — and rather
 * than leaving them pending, because a row behind a card that has been decided is exactly
 * the "undefined disposition" that made the earlier key dangerous.
 *
 * 🚨 The `supersedes` COLUMN is not written here and cannot be: it is frozen by the trigger
 * (see `transition.ts`). The relationship is recoverable without it — these rows are
 * byte-identical by construction, sharing the very key they were grouped by.
 */
export async function approveCard(
  pool: pg.Pool,
  card: CollapsedCard,
  approverUserId: string,
): Promise<void> {
  // ONE TRANSACTION, over the primary AND every repeat. Not tidiness: done as separate
  // transactions, a crash in the window leaves the repeats `pending`, so they re-render as
  // a card the human already answered — and approving THAT produces a second, byte-
  // identical outward action. It fails toward asking the human again, which is the safe
  // direction, but "the safe direction" is not a reason to leave a window open that costs
  // nothing to close.
  await inTransaction(pool, async (client) => {
    await decideOn(client, { proposalId: card.primary.id, kind: "approved", approverUserId });
    for (const dup of card.duplicates) {
      await transition(client, { id: dup.id, from: "pending", to: "superseded" });
    }
  });
}

/** Run `fn` inside one transaction on one client. The trigger's same-transaction predicate
 *  makes the boundary load-bearing, so it is explicit here rather than implied by a pool. */
async function inTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Reject a card: rejecting it rejects ALL of them, each with its own attributable decision
 * row. A repeat left pending after its card was rejected would come back as a card the
 * human already answered.
 */
export async function rejectCard(
  pool: pg.Pool,
  card: CollapsedCard,
  approverUserId: string,
  reason: string,
): Promise<void> {
  // Same reasoning, same transaction: a partial rejection leaves repeats pending behind a
  // card that was answered. Every row still gets its OWN attributable decision row — one
  // transaction is not one decision.
  await inTransaction(pool, async (client) => {
    for (const row of [card.primary, ...card.duplicates]) {
      await decideOn(client, { proposalId: row.id, kind: "rejected", approverUserId, reason });
    }
  });
}
