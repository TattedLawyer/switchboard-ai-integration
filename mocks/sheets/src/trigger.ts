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

export function createTrigger(_opts: TriggerOptions): SheetTrigger {
  throw new Error("not implemented (RED)");
}
