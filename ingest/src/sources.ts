// stripefeed (Task B) is the Stripe-STYLE opaque-cursor envelope feed — registered like
// sheets (A5) for the deployment surface (base URL env, port, INGEST_SOURCES opt-in,
// connector registry arm), and like sheets deliberately NOT default-enabled. It lands
// ALONGSIDE the 2a billing mock (risk rule: nothing rewritten in place; the staging/
// warehouse switch is Task F's).
// hubcrm (Task C) is the HubSpot-STYLE thin-webhook + hydration source — registered like
// stripefeed (deployment surface: base URL env, port 4007, INGEST_SOURCES opt-in,
// WEBHOOK_SECRET_HUBCRM boot requirement when enabled, connector registry arm) and like
// it deliberately NOT default-enabled. It lands ALONGSIDE the 2a crm mock (risk rule:
// nothing rewritten in place; Task F owns the old CRM's retirement).
// casebus (Task D) is the event-bus SUBSCRIBE/REPLAY support source — the fourth and last
// paradigm — registered like stripefeed and hubcrm (deployment surface: CASEBUS_BASE_URL,
// port 4008, INGEST_SOURCES opt-in) and like them deliberately NOT default-enabled. It
// lands ALONGSIDE the 2a support mock (risk rule: nothing rewritten in place; the
// staging/warehouse switch is Task F's).
// F-1c: the 2a crm MOCK is retired (hubcrm is the CRM; the warehouse stages from it).
// The `crm` literal stays REGISTERED as a legacy ledger-feed lane: raw rows under it may
// exist in deployed databases, many door/contract suites exercise the generic machinery
// through it, and removing a Source is a wider spec change that rides the full 2a
// retirement wave (billing/support mocks' own retirement — the register owns the line).
// Nothing serves its port and it is no longer default-enabled.
export const SOURCES = ["crm", "billing", "support", "sheets", "stripefeed", "hubcrm", "casebus"] as const;
export type Source = (typeof SOURCES)[number];

export function isSource(v: string): v is Source {
  return (SOURCES as readonly string[]).includes(v);
}

const DEFAULT_PORTS: Record<Source, number> = { crm: 4001, billing: 4003, support: 4004, sheets: 4005, stripefeed: 4006, hubcrm: 4007, casebus: 4008 };

export function baseUrlFor(source: Source): string {
  return process.env[`${source.toUpperCase()}_BASE_URL`] ?? `http://localhost:${DEFAULT_PORTS[source]}`;
}

// The feed+ledger 2a pair polls by default (a trio until F-1c retired the crm mock). sheets (A5) is deliberately NOT in the default:
// it has no /events feed, so the surfaces this default drives — main.ts's feed-shaped
// interval backfill, the demo scripts — have nothing to poll there. A deployment opts a
// sheet in via INGEST_SOURCES, which also makes WEBHOOK_SECRET_SHEETS a boot requirement
// (assertWebhookSecrets runs over enabledSources) exactly where the source is on. The
// connector-seam CLIs (cli/backfill, cli/reconcile) route every enabled source through
// connectorFor, so an opted-in sheets source catches up and reconciles correctly there.
// stripefeed (Task B) follows the same posture: registered, opt-in only. Its /v1/events
// contract is its own connector's business; opting in makes WEBHOOK_SECRET_STRIPEFEED a
// boot requirement even though the paradigm is pull-only — the generic /webhooks/:source
// door exists for every registered source, and an armed-but-unused door still needs a
// real secret rather than a silent hole (documented in RUNBOOK). casebus (Task D) takes
// the identical posture: registered, opt-in only, pull-only (a SUBSCRIBER, not a
// receiver), and opting it in makes WEBHOOK_SECRET_CASEBUS a boot requirement for the
// same armed-door reason.
// F-1c: `crm` left the default — its mock is deleted, so a default deployment polling
// port 4001 would poll nothing forever. The faithful sources stay opt-in per their
// documented deployment-surface posture; scripts pin INGEST_SOURCES explicitly.
const DEFAULT_ENABLED: readonly Source[] = ["billing", "support"];

// Which sources this deployment actually polls/reconciles. Scripts pin this explicitly;
// code default is the 2a feed pair (see above).
//
// PRE-3 (#21): STRICT, under `config.ts`'s recorded doctrine — "present and invalid →
// throw at boot. The error text is an OPERATOR SURFACE: it names the variable, echoes
// the rejected value, and states what would be accepted." This variable used to be the
// one boot input outside that doctrine: `.filter(isSource)` silently dropped anything it
// did not recognise, so `INGEST_SOURCES=hubcrm,stripfeed` ran one source and
// `INGEST_SOURCES=` ran zero — in both cases with every webhook door still armed, which
// is what made the disabled-source door (#15) dangerous rather than merely untidy.
//
// Empty deliberately DIVERGES from `intFromEnv`/`choiceFromEnv`, where empty means the
// default. For a scalar knob the default is a working value; here "explicitly zero
// sources" and "forgot to set it" are indistinguishable, and guessing wrong yields a
// process that ingests nothing forever. So empty is a refusal that names the way to ask
// for the default: unset the variable.
//
// The `env` parameter mirrors `config.ts`'s parsers so the wording can be pinned without
// mutating the ambient environment.
export function enabledSources(env: NodeJS.ProcessEnv = process.env): Source[] {
  const raw = env.INGEST_SOURCES;
  if (raw === undefined) return [...DEFAULT_ENABLED];

  const accepted = `must be a comma-separated list of ${SOURCES.join(", ")}`;
  if (raw.trim() === "") {
    throw new Error(
      `invalid INGEST_SOURCES "${raw}": must name at least one of ${SOURCES.join(", ")} — ` +
        `unset INGEST_SOURCES to use the default (${DEFAULT_ENABLED.join(", ")})`,
    );
  }

  const entries = raw.split(",").map((s) => s.trim());
  const result: Source[] = [];
  entries.forEach((entry, i) => {
    // A blank entry gets its own complaint — `unknown source ""` would be unreadable,
    // and the position is the only thing that locates a comma typo in a long list.
    if (entry === "") {
      throw new Error(
        `invalid INGEST_SOURCES "${raw}": empty entry at position ${i + 1} — ${accepted}`,
      );
    }
    if (!isSource(entry)) {
      throw new Error(`invalid INGEST_SOURCES "${raw}": unknown source "${entry}" — ${accepted}`);
    }
    result.push(entry);
  });
  return result;
}

export function ledgerPathFor(source: Source): string | undefined {
  return process.env[`LEDGER_PATH_${source.toUpperCase()}`];
}
