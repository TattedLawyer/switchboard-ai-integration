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

  /**
   * `tenantId` is REQUIRED (CLOSE-3 fix round). This connector's poll path is the recovery
   * path for what the push doors lost, so it must write into the SAME lane the doors write
   * into. It defaulted to the nil tenant while the doors wrote the configured one, which
   * split every recovered event into a second row under
   * `(tenant_id, source, event_id)` — the uniqueness that was supposed to absorb it.
   */
  constructor(
    readonly source: Source,
    private readonly tenantId: string,
  ) {}

  async catchUp(pool: pg.Pool, opts?: ConnectorCatchUpOptions): Promise<number> {
    const baseUrl = opts?.baseUrl ?? baseUrlFor(this.source);
    return catchUp(pool, this.source, baseUrl, {
      limit: opts?.limit,
      maxRounds: opts?.maxRounds,
      tenantId: this.tenantId,
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
      // FAIL CLOSED (debt-burn A8): this source is ENABLED in INGEST_SOURCES and its
      // paradigm declares a ledger — an unset LEDGER_PATH_<S> here is a config error
      // (typo'd variable, missed export), not consent to skip. Returning a skip let one
      // typo silently drop a source from the zero-loss proof while the aggregate said
      // PASS. Unset is never consent; the explicit literal `skip` below is.
      const varName = `LEDGER_PATH_${this.source.toUpperCase()}`;
      return {
        integrity: {
          ok: false,
          detail:
            `${varName} is not set for enabled source ${this.source} — refusing to silently drop it from ` +
            `the reconcile. Set ${varName} to the ledger file, or to the literal value "skip" to opt this ` +
            "source out explicitly.",
        },
      };
    }
    if (ledgerPath === "skip") {
      // The explicit, on-the-record escape hatch: a deployment that genuinely wants a
      // ledger-feed source unreconciled says so by name, not by omission.
      return {
        skipped: `LEDGER_PATH_${this.source.toUpperCase()}=skip (explicit opt-out)`,
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
