import { getPool } from "../db.js";
import { resolveDeploymentTenant } from "../config.js";
import { baseUrlFor, enabledSources, type Source } from "../sources.js";
import {
  BusReplayConnector,
  HubHydrateConnector,
  SheetSnapshotConnector,
  StripeFeedConnector,
  connectorFor,
  formatGapLedgerRow,
  listGaps,
  type Connector,
} from "../connectors/index.js";
import { gapCrossCheck, type ReportedGapLike } from "./gap-crosscheck.js";
import { hasRecordedTenantState, noRecordedStateMessage } from "./tenant-state.js";
import { DEFAULT_TENANT_ID } from "../ingest-event.js";
import type { ReconcileReport } from "../reconcile.js";
import type { SheetReconcileReport } from "../connectors/sheet-snapshot.js";
import type { StripeFeedReconcileReport } from "../connectors/stripe-feed.js";
import type { HubReconcileReport, HydrationDlqEntry } from "../connectors/hub-hydrate.js";
import type { BusReconcileReport } from "../connectors/bus-replay.js";

// Bounded listing for the stale bucket: unlike missing/extra (which converge toward
// empty on a healthy source), stale can be O(sheet) after a bulk edit — an operator
// needs the first row_keys to start fix-the-cell triage, not ten thousand lines.
const STALE_LIST_CAP = 20;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

/**
 * Tenancy (debt-burn A5): with `--tenant`, every tenant-capable connector is constructed
 * scoped to that tenant (same registry wiring, tenant threaded in). Without the flag the
 * registry's default construction is used unchanged — the default tenant's behavior is
 * byte-identical to before the flag existed.
 *
 * Exported for the drift pin (sweep item 4): this switch DUPLICATES the registry's
 * wiring by necessity (the registry constructs default-tenant connectors; the seam has
 * no tenant parameter), so `reconcile-tenant-drift.test.ts` asserts per kind that both
 * paths produce the same connector class with the same config, tenant aside. If the
 * registry gains a source, kind, or construction option, that pin — plus the compiler's
 * exhaustiveness on `kind` — is what forces this copy to follow.
 */
export function connectorForTenant(
  source: Source,
  tenantId: string,
  /** True only when the operator passed --tenant. The ledger-feed refusal below is about
   *  the MULTI-tenant question ("reconcile tenant X's rows against everyone's ledger"),
   *  not about the value: on a single-tenant deployment with SWITCHBOARD_TENANT_ID set,
   *  every raw row IS that tenant's and the ledger IS the whole feed, so a bare reconcile
   *  must keep working. Keying the refusal on the value instead would have made this fix
   *  break bare reconcile on exactly the deployments it exists to serve. */
  explicitTenantFlag = true,
): Connector {
  // CLOSE-3 fix round: this used to DUPLICATE the registry's wiring by necessity, because
  // the registry constructed default-tenant connectors and the seam had no tenant
  // parameter — and `reconcile-tenant-drift.test.ts` existed to catch the copy drifting.
  // The registry now takes the tenant, so the copy is gone and the drift it guarded
  // against is impossible rather than merely tested for. Kept as a named function because
  // main() and the drift pin both call it, and because the ledger-feed refusal below is a
  // reconcile-specific rule, not a registry rule.
  if (connectorFor(source, tenantId).kind === "ledger-feed" && explicitTenantFlag && tenantId !== DEFAULT_TENANT_ID) {
    // Unreachable in practice: main() refuses --tenant for ledger-feed sources before this
    // runs. A ledger-feed source's oracle is a file on disk with no tenant in it, so
    // reconciling one "as tenant X" would compare X's rows against everyone's ledger.
    throw new Error(`--tenant is not supported for ledger-feed source ${source}`);
  }
  return connectorFor(source, tenantId);
}

/**
 * The parenthetical a PASS line carries when the run is clean but a DISCLOSED, PERMANENT
 * condition still stands. Empty string when nothing stands, so the ordinary PASS line is
 * unchanged.
 *
 * Acknowledged permanent gaps have been caveated this way since the gap ledger shipped.
 * The hydration DLQ was added at gate-H I4: excluding it from `clean` is deliberate and
 * defensible (the stripefeed quarantine precedent — one permanently broken vendor object
 * must not red every reconcile forever), but that decision is about GATING, and it was
 * silently extended to the WORDING. The hub verdict read "store, raw thin events, and
 * hydrated snapshots agree; nothing pending" with N terminal dead letters standing. A
 * standing DLQ is the same species as a standing acknowledged gap: disclosed, permanent
 * until an operator acts, and not a clean bill of health.
 */
export function standingConditionsNote(opts: { acknowledgedGaps: number; hydrationDlq: number }): string {
  const parts: string[] = [];
  if (opts.acknowledgedGaps > 0) parts.push(`${opts.acknowledgedGaps} acknowledged permanent gap(s) standing`);
  if (opts.hydrationDlq > 0) parts.push(`${opts.hydrationDlq} terminal hydration dead letter(s) standing`);
  return parts.length === 0 ? "" : ` (with ${parts.join(" and ")} — see above)`;
}

async function main(): Promise<void> {
  const pool = getPool();
  let reconciledCount = 0;
  let allClean = true;
  // Bare-flag guard (review I2), identical to gap-ack's: a --tenant whose value was
  // forgotten or swallowed must refuse, not silently reconcile the DEFAULT tenant and
  // exit 0 while the operator believes tenant X was checked.
  const tenantArg = arg("tenant");
  if (has("tenant") && (tenantArg === undefined || tenantArg.startsWith("--"))) {
    console.error("--tenant requires a tenant id");
    await pool.end();
    process.exit(1);
  }
  // CLOSE-3 fix round: the default is the DEPLOYMENT's tenant, not a hardcoded nil. With
  // SWITCHBOARD_TENANT_ID set, a bare `npm run reconcile` used to check the nil lane —
  // empty — and report a clean run over a pipeline writing somewhere else entirely. Unset
  // deployments resolve to the nil tenant, so their behaviour is byte-identical to before.
  const tenantId = tenantArg ?? resolveDeploymentTenant();

  try {
    // Keyed on the FLAG, not the value — matching connectorForTenant's gate below, which
    // is the same rule and must not be able to disagree with this one. Keying it on the
    // value (as it did until the close-out round) refused a bare `npm run reconcile` on
    // any deployment with SWITCHBOARD_TENANT_ID set, quoting a --tenant the operator never
    // passed — and since DEFAULT_ENABLED is billing,support and both demo.sh and chaos.sh
    // enable ledger-feed sources, that disabled the zero-loss surface on precisely the
    // deployments the tenant work exists to serve.
    if (has("tenant")) {
      // Refuse, by name, what would otherwise be a silently WRONG answer: the ledger-feed
      // paradigm's reconcile compares the source's whole raw lane against a single ledger
      // file — it is not tenant-scoped, so running it "for tenant X" would quietly answer
      // for every tenant at once. The other four paradigms are tenant-scoped end to end.
      //
      // Known wart, deliberately left (KNOWN-ISSUES, with an owner): `--tenant <the
      // deployment's own tenant>` is refused while a bare run of identical scope is not.
      // Conservative and loud beats clever here, but letting the equal case through is the
      // obvious follow-up.
      const unsupported = enabledSources().filter((s) => connectorFor(s, DEFAULT_TENANT_ID).kind === "ledger-feed");
      if (unsupported.length > 0) {
        console.error(
          `--tenant is not supported for ledger-feed source(s) ${unsupported.join(", ")}: ` +
            "their ledger-vs-raw reconcile is not tenant-scoped, and a cross-tenant answer dressed as " +
            "a per-tenant one would be worse than this refusal",
        );
        await pool.end();
        process.exit(1);
      }
    }
    // Close F8: an EXPLICITLY named tenant this database has never seen must refuse, not
    // reconcile an empty world to a clean PASS. Flag-absent runs are untouched — a fresh
    // deployment's default tenant legitimately starts with zero state.
    if (has("tenant") && !(await hasRecordedTenantState(pool, tenantId))) {
      console.error(noRecordedStateMessage(tenantId));
      await pool.end();
      process.exit(1);
    }

    // ── the durable disclosure, printed BEFORE any degraded-path exit ────────────────
    //
    // Cold review I1: this read used to sit below the `skipped` and `!integrity.ok`
    // continues, so a source that was unreachable or unreadable printed its live
    // failure and NOTHING about the permanent losses already on its record — at exactly
    // the moment an operator is reading this output. The gate still held (exit nonzero),
    // but the disclosure is the point of the ledger: a row nobody prints is a row nobody
    // acts on. A standing loss is a fact about the past; it is not contingent on whether
    // the source answered the phone today. Hoisted to a helper at close (F13) so the
    // per-source CATCH below discloses the identical record when reconcile() throws —
    // one shape, two callers, the two outputs cannot drift (checklist line 6).
    const discloseStandingGaps = async (
      source: Source,
      priorGapIds: Set<number>,
    ): Promise<{ ledgerGaps: Awaited<ReturnType<typeof listGaps>>; unacknowledged: Awaited<ReturnType<typeof listGaps>> }> => {
      const ledgerGaps = await listGaps(pool, tenantId, source);
      const unacknowledged = ledgerGaps.filter((g) => g.acknowledgedAt === null);
      if (ledgerGaps.length > 0) {
        console.error(
          `[${source}] gap ledger: ${ledgerGaps.length} recorded permanent loss(es), ` +
            `${unacknowledged.length} unacknowledged — read from ingest.gap_ledger, independent of this run's live read`,
        );
      }
      // Every gap is printed, acknowledged or not: acknowledging a loss records that a
      // human accepted it, it does not make it stop being true. Each line says whether it
      // was already on the record or was found just now, so a standing loss is never
      // mistaken for fresh damage during an incident (and vice versa).
      for (const gap of ledgerGaps) {
        const when = priorGapIds.has(gap.id) ? "standing (recorded before this run)" : "detected in this run";
        console.error(`${formatGapLedgerRow(source, gap)} — ${when}`);
      }
      if (unacknowledged.length > 0) {
        // A red with no next step is how reconcile gets ignored. Print the exact command.
        const tenantFlag = tenantId === DEFAULT_TENANT_ID ? "" : ` --tenant ${tenantId}`;
        console.error(
          `[${source}] ${unacknowledged.length} UNACKNOWLEDGED gap(s). No retry can close a gap — once you have ` +
            "accepted the loss, record it:\n" +
            `  node --import tsx src/cli/gap-ack.ts --source ${source} --id <n> --by <operator> --note "why"${tenantFlag}`,
        );
      }
      return { ledgerGaps, unacknowledged };
    };

    for (const source of enabledSources()) {
      const connector = connectorForTenant(source, tenantId, has("tenant"));

      // Which losses were already on the record BEFORE this run. Taken as ids rather than
      // by comparing timestamps because `detected_at` is the DATABASE clock and this is
      // the app clock; an id-set diff needs no clock at all.
      const priorGapIds = new Set((await listGaps(pool, tenantId, source)).map((g) => g.id));

      // Close F13 (the A2 residue): a throw out of reconcile() — deliberately including
      // the fail-loud gap_ledger INSERT failure (A2's record-before-report verdict, kept:
      // the connector must never report a loss it could not record) — used to land in
      // this CLI's top-level catch and kill the run before LATER sources printed their
      // standing state: disclosure-dies-during-an-incident, through the database door.
      // A1's per-source containment shape, applied to the write path: the throw is
      // contained to this source, its standing record is still disclosed (from the
      // ledger the SELECTs can still read — an INSERT failure is not an outage of them),
      // its live read is voided loudly, and the loop continues.
      let result;
      try {
        result = await connector.reconcile(pool);
      } catch (err) {
        const { unacknowledged } = await discloseStandingGaps(source, priorGapIds);
        if (unacknowledged.length > 0) allClean = false;
        console.log(
          `[${source}] FAIL: reconcile threw before returning a report — ` +
            `${err instanceof Error ? err.message : String(err)}. Nothing was reported for this ` +
            "source and no gap row was written by the failed detection (record-before-report); " +
            "the standing record above is the durable ledger's. Later sources continue.",
        );
        reconciledCount++;
        allClean = false;
        continue;
      }

      const { ledgerGaps, unacknowledged } = await discloseStandingGaps(source, priorGapIds);
      if (unacknowledged.length > 0) {
        // The gate is the ledger's, not the live read's: an unacknowledged permanent loss
        // reds the run even when this source was skipped or unreadable this time.
        allClean = false;
      }

      if (result.skipped) {
        console.log(`[${source}] skipped (${result.skipped})`);
        continue;
      }

      if (!result.integrity.ok) {
        console.log(`[${source}] FAIL: ${result.integrity.detail ?? "source record not trusted"}`);
        reconciledCount++;
        allClean = false;
        continue;
      }
      // Paradigm-honest integrity line (cold review Minor 6): say what reconcile
      // actually verified for THIS connector kind. The sheets paradigm has no ledger
      // file and no hash chain — printing "ledger hash chain: ok" there was false.
      if (connector.kind === "sheet-snapshot") {
        console.log(`[${source}] snapshot integrity: ok (sheet readable, metadata/key mapping consistent)`);
      } else if (connector.kind === "stripe-feed") {
        // Cold review I1 — the same dishonesty class Minor 6 fixed for sheets, which
        // the third paradigm silently reintroduced: no ledger file, no hash chain here.
        console.log(
          `[${source}] feed window integrity: ok (retained window fully drained, envelopes well-formed, feed advancing)`,
        );
      } else if (connector.kind === "bus-replay") {
        // Task D standing checklist: the FIFTH arm's honest line. A bus has no ledger
        // file and no hash chain — what reconcile ACTUALLY verified is that the whole
        // retained window was drained through to has_more=false, every frame carried an
        // identity, and the subscription kept advancing.
        console.log(
          `[${source}] event stream integrity: ok (retained window fully drained, every frame identified, subscription advancing)`,
        );
      } else if (connector.kind === "hub-hydrate") {
        // Task C standing checklist: the fourth paradigm's honest line — an object
        // store has no ledger file and no hash chain; what reconcile ACTUALLY verified
        // is that all three object listings were readable and every object was compared
        // against raw thin events + hydrated snapshots.
        console.log(
          `[${source}] object-store integrity: ok (company/contact/deal listings read; ` +
            "current state compared against raw thin events + hydrated snapshots)",
        );
      } else {
        console.log(`[${source}] ledger hash chain: ok`);
      }

      // integrity.ok with no skip guarantees a report; this satisfies the type checker without
      // inventing a fallback that would silently pass an unreconciled source.
      const report = result.report!;
      reconciledCount++;

      // ── Exhaustive-consumption contract (docs/operator-surface-checklist.md line 1,
      // compile-time) ─────────────────────────────────────────────────────────────────
      // "Every field a connector's report can carry is consumed and printed by both CLIs
      // and the service log, or explicitly discarded with a comment naming why." Here that
      // sentence is compiled: every paradigm's report shape is fully rest-destructured,
      // and the remainder is typed EMPTY — a field added to any report shape without a
      // decided operator surface is a compile error in this CLI before any test, matrix,
      // or reviewer is involved (the Task B `gaps` / A-slice `stale` escape class,
      // mechanized). Everything printed below reads ONLY these destructured bindings; a
      // field that is deliberately not printed must be discarded here with a comment
      // naming why. The `as` casts are the same kind-narrowing the producers guarantee:
      // each connector's reconcile() returns its own report shape for its own kind.
      type BaseBuckets = Pick<
        ReconcileReport,
        "ledger" | "raw" | "missing" | "extra" | "rawDuplicates" | "ledgerDuplicates" | "crossTenantEventIds"
      >;
      // The `_*XT` discards below are checklist-line-1 explicit discards, not oversights:
      // `crossTenantEventIds` is a ledger-paradigm field (gate-H I8). The other four
      // paradigms scope every one of their reads by tenant end to end, so they cannot
      // produce a cross-tenant collision, and a line printing zero of them on those
      // sources would be noise asserting a condition their shape forbids.
      let base: BaseBuckets;
      let stale: string[] | undefined;
      let windowed: { agedOutRaw: number; quarantined: { event_id: string; count: number }[] } | undefined;
      let reportedGaps: readonly ReportedGapLike[] | undefined;
      let hub:
        | { drifted: string[]; mergedAwayRaw: number; tombstonedRaw: number; hydrationPending: number; hydrationDlq: HydrationDlqEntry[] }
        | undefined;
      switch (connector.kind) {
        case "ledger-feed": {
          const { ledger, raw, missing, extra, rawDuplicates, ledgerDuplicates, crossTenantEventIds, ...rest } = report;
          rest satisfies Record<string, never>;
          base = { ledger, raw, missing, extra, rawDuplicates, ledgerDuplicates, crossTenantEventIds };
          break;
        }
        case "sheet-snapshot": {
          const { ledger, raw, missing, extra, rawDuplicates, ledgerDuplicates, crossTenantEventIds: _sheetXT, stale: sheetStale, ...rest } =
            report as SheetReconcileReport;
          rest satisfies Record<string, never>;
          base = { ledger, raw, missing, extra, rawDuplicates, ledgerDuplicates, crossTenantEventIds: undefined };
          stale = sheetStale;
          break;
        }
        case "stripe-feed": {
          const { ledger, raw, missing, extra, rawDuplicates, ledgerDuplicates, crossTenantEventIds: _feedXT, agedOutRaw, quarantined, gaps, ...rest } =
            report as StripeFeedReconcileReport;
          rest satisfies Record<string, never>;
          base = { ledger, raw, missing, extra, rawDuplicates, ledgerDuplicates, crossTenantEventIds: undefined };
          windowed = { agedOutRaw, quarantined };
          reportedGaps = gaps;
          break;
        }
        case "bus-replay": {
          const { ledger, raw, missing, extra, rawDuplicates, ledgerDuplicates, crossTenantEventIds: _busXT, agedOutRaw, quarantined, gaps, ...rest } =
            report as BusReconcileReport;
          rest satisfies Record<string, never>;
          base = { ledger, raw, missing, extra, rawDuplicates, ledgerDuplicates, crossTenantEventIds: undefined };
          windowed = { agedOutRaw, quarantined };
          reportedGaps = gaps;
          break;
        }
        case "hub-hydrate": {
          const {
            ledger, raw, missing, extra, rawDuplicates, ledgerDuplicates, crossTenantEventIds: _hubXT,
            drifted, mergedAwayRaw, tombstonedRaw, hydrationPending, hydrationDlq, ...rest
          } = report as HubReconcileReport;
          rest satisfies Record<string, never>;
          base = { ledger, raw, missing, extra, rawDuplicates, ledgerDuplicates, crossTenantEventIds: undefined };
          hub = { drifted, mergedAwayRaw, tombstonedRaw, hydrationPending, hydrationDlq };
          break;
        }
      }

      // Debt-burn A3: the loss-bearing paradigms' reports carry their own `gaps`
      // accounting, and it is CONSUMED here as a cross-check against the ledger rows
      // printed above — the two surfaces must agree or the run reds naming the drift.
      // (This un-inverts the standing operator-surface checklist for the field:
      // produced ⇒ read on a shipped surface, and agreement is printed even at zero.
      // KNOWN-ISSUES' deferred minor stands unchanged: the bus arm remains structurally
      // vacuous — its report gaps come from the same listGaps read — and phase-close
      // owns that; the destructure above changes where the field is READ, not its value.)
      let gapCrossCheckOk = true;
      if (reportedGaps !== undefined) {
        const check = gapCrossCheck(reportedGaps, ledgerGaps);
        if (check.ok) {
          // Close F10 — the printed claim is narrowed to what each arm actually proves.
          // The STRIPEFEED report derives its gaps independently (its catchUp/reconcile
          // accounting), so agreement there is a real cross-check. The BUS report's
          // `gaps` field is built from the same listGaps query this CLI compares it
          // against (bus-replay.ts reconcile return), so its agreement is structural
          // self-consistency — printing "agrees with the ledger" there claimed a
          // discriminating check that cannot discriminate. The comparison still RUNS on
          // both arms (a bus-arm mismatch is impossible by construction; if it ever
          // fires, something is deeply wrong and the red below says what drifted) —
          // only the PASS-line claim is honest per arm. An independent bus derivation
          // is real design work, deliberately not close scope.
          if (connector.kind === "bus-replay") {
            console.log(
              `[${source}] gap cross-check (structural): the bus report's gaps are the ledger's own rows — self-consistency, not an independent derivation (${reportedGaps.length} gap(s))`,
            );
          } else {
            console.log(
              `[${source}] gap cross-check: report agrees with the durable gap ledger (${reportedGaps.length} gap(s))`,
            );
          }
        } else {
          gapCrossCheckOk = false;
          console.error(
            `[${source}] FAIL: reconcile report gaps disagree with the durable gap ledger — ${check.detail}`,
          );
        }
      }

      // Task C: hub-shaped reports reconcile OBJECTS against the vendor store, not
      // event ids against a ledger — label every count as what it actually is.
      if (connector.kind === "stripe-feed") {
        // The number is a 30-day WINDOW, not a ledger file — label it as what it is.
        console.log(`[${source}] retained window: ${base.ledger} event(s) (the feed's 30-day ledger-equivalent)`);
      } else if (connector.kind === "bus-replay") {
        console.log(`[${source}] retained window: ${base.ledger} event(s) (the bus's 72h ledger-equivalent)`);
      } else if (hub !== undefined) {
        console.log(`[${source}] object store: ${base.ledger} live object(s) (the paradigm's ledger-equivalent)`);
      } else {
        console.log(`[${source}] ledger: ${base.ledger} distinct event_id(s)`);
      }
      if (hub !== undefined) {
        console.log(`[${source}] raw:    ${base.raw} thin event(s)`);
      } else {
        console.log(`[${source}] raw:    ${base.raw} distinct event_id(s)`);
      }
      console.log(`[${source}] raw duplicates: ${base.rawDuplicates}`);
      if (base.crossTenantEventIds !== undefined && base.crossTenantEventIds.length > 0) {
        // Gate-H I8. Printed only when nonzero, and deliberately NOT gated: on a database
        // that ingested under the nil tenant before SWITCHBOARD_TENANT_ID was set, the
        // same event_id legitimately exists once per tenant, and the ledger-vs-raw
        // comparison is whole-lane by design (the ledger carries no tenant). Before this,
        // those rows were counted as raw duplicates and the run reported a permanent
        // `FAIL: reconciliation found discrepancies` with nothing anywhere saying why.
        console.log(
          `[${source}] cross-tenant event_id(s) (present under more than one tenant — legitimate since ` +
            `migration 006 made uniqueness per-tenant; this ledger reconcile is whole-lane by design, so ` +
            `they are context, not a discrepancy): ${base.crossTenantEventIds.length}`,
        );
        for (const id of base.crossTenantEventIds) console.log(`  - ${id}`);
      }
      if (base.ledgerDuplicates !== undefined) {
        // Debt-burn A6 (operator-surface rule: a produced field is printed). Nonzero is
        // unreachable on this path today — the chain verifier rejects duplicate ids
        // before reconcile runs — printed anyway so the count comparison's honesty is
        // visible, and gated below as defense in depth.
        console.log(`[${source}] ledger duplicates (same event_id appended more than once — writer bug): ${base.ledgerDuplicates}`);
      }
      if (hub !== undefined) {
        console.log(`[${source}] missing (in the object store, never seen in raw — lost webhooks): ${base.missing.length}`);
      } else {
        console.log(`[${source}] missing (in ledger, not in raw): ${base.missing.length}`);
      }
      if (base.missing.length > 0) {
        for (const id of base.missing) console.log(`  - ${id}`);
      }
      if (hub !== undefined) {
        console.log(`[${source}] extra (in raw, absent from the store, no deletion event to explain it): ${base.extra.length}`);
      } else {
        console.log(`[${source}] extra (in raw, not in ledger): ${base.extra.length}`);
      }
      if (base.extra.length > 0) {
        for (const id of base.extra) console.log(`  - ${id}`);
      }

      // Cold review I1: sheet-shaped reports carry a fourth bucket the ledger paradigm
      // has no equivalent of — `stale` = present on both sides but content differs, the
      // snapshot paradigm's EVERYDAY drift (a human edits a cell after a clean ingest;
      // quarantined-current rows live here too). Ignoring it made a drifted sheet print
      // PASS. It is surfaced (bounded) and folded into the pass/fail decision below.
      if (stale !== undefined) {
        console.log(`[${source}] stale (present on both sides, content differs): ${stale.length}`);
        for (const rowKey of stale.slice(0, STALE_LIST_CAP)) console.log(`  - ${rowKey}`);
        if (stale.length > STALE_LIST_CAP) {
          console.log(`  ... and ${stale.length - STALE_LIST_CAP} more (listing capped at ${STALE_LIST_CAP})`);
        }
      }

      // Cold review C1/I2 — the retention paradigm's own buckets. agedOutRaw is the
      // window's normal metabolism (printed for context, never gated). `quarantined`
      // is retained-but-diverted: preserved in ingest.quarantine, replayable, NOT
      // ingestion loss — named and counted so the operator looks in the right place,
      // and deliberately not a failure by itself (one poisoned vendor event must not
      // red a month of reconciles). `gaps` are the paradigm's admitted permanent
      // losses and they GATE: a gap is never a PASS-silently condition. Exit-nonzero-
      // on-first-appearance is the deliberate v1 (per-process detection means a fresh
      // process after the fallback no longer sees it, so a permanent red is impossible
      // today); the acknowledged-gap workflow arrives with the durable gap ledger
      // (register follow-up, shared with the bus task).
      // Task C: the hydration paradigm's own buckets, each printed with its meaning.
      // tombstonedRaw is normal metabolism (deleted WITH a deletion event — context,
      // never gated). `drifted` and `missing` are the paradigm's admitted webhook
      // losses and they GATE. `hydration pending` gates too: limbo violates the
      // trichotomy oracle. The DLQ is DELIBERATELY not a failure by itself (stripefeed
      // quarantine precedent: one permanently-broken vendor object must not red every
      // reconcile forever) — it is counted and listed with reasons so the operator
      // looks in the right place.
      if (hub !== undefined) {
        console.log(`[${source}] tombstoned (deleted with a deletion event in raw — expected metabolism): ${hub.tombstonedRaw}`);
        // F-1b: as rich as the tombstone line (checklist line 6 — same absent-from-store
        // condition, different explanation, different operator follow-up).
        console.log(`[${source}] merged away (consumed by a merge event in raw — survivor carries hs_merged_object_ids): ${hub.mergedAwayRaw}`);
        console.log(`[${source}] drifted (store moved, no webhook told us — latest snapshot differs): ${hub.drifted.length}`);
        for (const key of hub.drifted) console.log(`  - ${key}`);
        console.log(`[${source}] hydration pending (no terminal state yet — the pump continues next run): ${hub.hydrationPending}`);
        console.log(`[${source}] hydration DLQ (terminal fetch failures, preserved — replay is an operator act): ${hub.hydrationDlq.length}`);
        for (const d of hub.hydrationDlq) console.log(`  - ${d.event_id} (${d.object_type}:${d.object_id}) ${d.reason}`);
      }

      // The two WINDOW-BOUNDED paradigms (stripefeed's 30-day feed, casebus's 72h bus)
      // report the same extra buckets, so they print through one branch: `agedOutRaw` is
      // the window's normal metabolism (context, never gated) and `quarantined` is
      // retained-but-diverted — preserved, replayable, and deliberately not a failure by
      // itself, because one poisoned vendor event must not red every reconcile for the
      // length of the window.
      if (windowed !== undefined) {
        console.log(`[${source}] aged out of window (in raw, ingested before expiry — expected): ${windowed.agedOutRaw}`);
        console.log(
          `[${source}] quarantined (retained at the source, preserved in ingest.quarantine — not counted as missing): ${windowed.quarantined.length}`,
        );
        for (const q of windowed.quarantined) console.log(`  - ${q.event_id} (${q.count} quarantine row(s))`);
      }

      // The gap ledger was read and printed ABOVE, before the degraded-path exits — see
      // the cold-review I1 note there. `unacknowledged` is in scope from that read and is
      // what gates below; it is deliberately NOT re-read here, so the line an operator saw
      // and the verdict they get cannot disagree.
      const clean =
        base.missing.length === 0 &&
        base.extra.length === 0 &&
        base.rawDuplicates === 0 &&
        (stale?.length ?? 0) === 0 &&
        unacknowledged.length === 0 &&
        (hub?.drifted.length ?? 0) === 0 &&
        (hub?.hydrationPending ?? 0) === 0 &&
        (base.ledgerDuplicates ?? 0) === 0 &&
        gapCrossCheckOk;
      if (clean) {
        // An acknowledged gap is a STANDING DISCLOSED CONDITION, not a clean bill of
        // health — so a PASS that has one says so on the same line.
        const ackNote = standingConditionsNote({
          acknowledgedGaps: ledgerGaps.length,
          hydrationDlq: hub?.hydrationDlq.length ?? 0,
        });
        // Paradigm-honest PASS line (cold review M1): the same class the integrity lines
        // above were rewritten for, left behind on the verdict itself. A bus and a feed
        // have no ledger; a sheet has no ledger file either. Say what actually matched.
        if (hub !== undefined) {
          console.log(`[${source}] PASS: store, raw thin events, and hydrated snapshots agree; nothing pending${ackNote}`);
        } else if (connector.kind === "bus-replay") {
          console.log(`[${source}] PASS: raw matches the bus's retained window exactly, no duplicates${ackNote}`);
        } else if (connector.kind === "stripe-feed") {
          console.log(`[${source}] PASS: raw matches the feed's retained window exactly, no duplicates${ackNote}`);
        } else if (connector.kind === "sheet-snapshot") {
          console.log(`[${source}] PASS: raw latest-state matches the sheet exactly, no duplicates${ackNote}`);
        } else {
          console.log(`[${source}] PASS: raw matches ledger exactly, no duplicates${ackNote}`);
        }
      } else if (unacknowledged.length > 0) {
        console.log(
          `[${source}] FAIL: ${unacknowledged.length} unacknowledged unclosable gap(s) reported — ` +
            "permanent data loss admitted at this source's boundary",
        );
        allClean = false;
      } else {
        console.log(`[${source}] FAIL: reconciliation found discrepancies`);
        allClean = false;
      }
    }

    if (reconciledCount === 0) {
      console.log("FAIL: no source had a ledger path set; nothing was reconciled");
    }

    await pool.end();
    process.exit(allClean && reconciledCount > 0 ? 0 : 1);
  } catch (err) {
    console.error("reconcile failed:", err);
    await pool.end();
    process.exit(1);
  }
}

// Entrypoint guard (main.ts precedent): tests import connectorForTenant for the drift
// pin; without the guard the import itself would run a full reconcile and process.exit.
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
