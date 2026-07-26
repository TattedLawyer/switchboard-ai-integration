import type pg from "pg";
import type { Source } from "../sources.js";
import { baseUrlFor, ledgerPathFor } from "../sources.js";
import { catchUp } from "../backfill.js";
import { reconcile, verifyLedgerChain } from "../reconcile.js";
import type {
  Connector,
  ConnectorCatchUpOptions,
  ConnectorReconcileOptions,
  ConnectorReconcileResult,
} from "./types.js";

/**
 * The shape every source had before the seam existed: an HTTP `/events` cursor feed for the pull
 * path, and a local JSONL hash-chained ledger as the source's own tamper-evident record.
 *
 * This class deliberately adds NO behavior. It is the same calls cli/backfill.ts and
 * cli/reconcile.ts were making inline, moved behind the interface so that sources which are not
 * this shape can exist alongside it. connector-seam.test.ts pins that equivalence directly —
 * if this ever drifts from the functions it wraps, those tests go red.
 */
export class LedgerFeedConnector implements Connector {
  readonly kind = "ledger-feed" as const;

  constructor(readonly source: Source) {}

  async catchUp(pool: pg.Pool, opts?: ConnectorCatchUpOptions): Promise<number> {
    const baseUrl = opts?.baseUrl ?? baseUrlFor(this.source);
    return catchUp(pool, this.source, baseUrl, {
      limit: opts?.limit,
      maxRounds: opts?.maxRounds,
    });
  }

  async reconcile(
    pool: pg.Pool,
    opts?: ConnectorReconcileOptions,
  ): Promise<ConnectorReconcileResult> {
    // `undefined` passed explicitly must still mean "not configured" — otherwise a caller that
    // threads an unset override would silently fall back to the environment and reconcile against
    // a ledger it did not ask for.
    const ledgerPath =
      opts && "ledgerPath" in opts ? opts.ledgerPath : ledgerPathFor(this.source);

    if (!ledgerPath) {
      return {
        skipped: `no LEDGER_PATH_${this.source.toUpperCase()}`,
        integrity: { ok: true },
      };
    }

    const chain = verifyLedgerChain(ledgerPath);
    if (!chain.ok) {
      // No report on purpose — see ConnectorReconcileResult.integrity.
      return {
        integrity: { ok: false, detail: `ledger hash chain broken at line ${chain.brokenAt}` },
      };
    }

    return { integrity: { ok: true }, report: await reconcile(pool, this.source, ledgerPath) };
  }
}
