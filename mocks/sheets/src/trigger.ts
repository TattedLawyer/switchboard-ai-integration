// The lossy push channel — models the Apps-Script installable-trigger side WITHOUT
// pretending it is reliable. Push is a latency optimization; the connector's
// reconcile() against /values is the guarantee.
//
// Honesty ledger for this module (plan §2):
//   DOCUMENTED  — "Script executions and API requests don't cause triggers to run"
//                 (installable-triggers reference): only the EDITOR's human path calls
//                 onHumanEdit; sheet.apply() (API/script writes) never reaches here.
//   DOCUMENTED  — Apps Script gives no delivery guarantee: a failed POST is counted
//                 and abandoned. No retry, ever.
//   UNVERIFIED → conservative — trigger queue depth under bulk edits: coalesced to ONE
//                 thin notification per human step, however many rows it changed.
//   UNVERIFIED → conservative — daily trigger budget (the 90-min/day class): after
//                 `dailyQuota` posts the channel goes SILENT, with no error signal.

import { prng, secretForSource, signBody } from "@switchboard/mock-core";

export type SheetNotification = {
  sheet_id: string;
  range: string; // A1 range the human touched — THIN: never the values themselves
  occurred_at: string;
};

export type TriggerOptions = {
  sheetId: string;
  webhookUrl: string;
  seed: number;
  /** Fraction of notifications silently lost in flight. Default 0. */
  dropRate?: number;
  /** Per-post artificial latency, applied in order (delivery order is preserved). */
  delayMs?: number;
  /** Posts allowed before the daily budget silences the channel. Default Infinity. */
  dailyQuota?: number;
};

export type TriggerStats = {
  attempted: number;
  posted: number;
  dropped: number;
  quotaSilenced: number;
  failed: number;
};

export type SheetTrigger = {
  onHumanEdit(e: { range: string; occurred_at: string }): void;
  /** Await all queued posts (posting is async; tests must flush before asserting). */
  flush(): Promise<void>;
  stats(): TriggerStats;
};

export function createTrigger(opts: TriggerOptions): SheetTrigger {
  const rand = prng(opts.seed);
  const dropRate = opts.dropRate ?? 0;
  const delayMs = opts.delayMs ?? 0;
  const dailyQuota = opts.dailyQuota ?? Infinity;
  const stats: TriggerStats = { attempted: 0, posted: 0, dropped: 0, quotaSilenced: 0, failed: 0 };
  // Budget is spent at ENQUEUE time (synchronously): posted/failed settle later in the
  // async chain, and the quota decision cannot depend on in-flight outcomes.
  let budgetUsed = 0;
  // Sequential post chain: preserves delivery order and lets tests flush deterministically.
  let chain: Promise<void> = Promise.resolve();

  const onHumanEdit = (e: { range: string; occurred_at: string }): void => {
    stats.attempted++;
    // UNVERIFIED → conservative: daily budget exhausted means SILENCE — no error path,
    // no signal to the sheet, nothing for the connector to key off. Only reconcile sees it.
    if (budgetUsed >= dailyQuota) {
      stats.quotaSilenced++;
      return;
    }
    // Seeded in-flight loss. DOCUMENTED: no delivery guarantee → a dropped notification
    // is gone forever; there is no retry machinery to even hand it to.
    if (rand() < dropRate) {
      stats.dropped++;
      return;
    }
    const notification: SheetNotification = {
      sheet_id: opts.sheetId,
      range: e.range,
      occurred_at: e.occurred_at,
    };
    const body = JSON.stringify(notification);
    budgetUsed++;
    chain = chain.then(async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      try {
        const res = await fetch(opts.webhookUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-switchboard-signature": signBody(body, secretForSource("sheets")),
          },
          body,
        });
        // DOCUMENTED: no retry on failure, ever — count it and move on.
        if (res.ok) stats.posted++;
        else stats.failed++;
      } catch {
        stats.failed++;
      }
    });
  };

  return {
    onHumanEdit,
    flush: () => chain,
    stats: () => ({ ...stats }),
  };
}
