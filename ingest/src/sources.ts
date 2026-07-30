export const SOURCES = ["crm", "billing", "support", "sheets"] as const;
export type Source = (typeof SOURCES)[number];

export function isSource(v: string): v is Source {
  return (SOURCES as readonly string[]).includes(v);
}

const DEFAULT_PORTS: Record<Source, number> = { crm: 4001, billing: 4003, support: 4004, sheets: 4005 };

export function baseUrlFor(source: Source): string {
  return process.env[`${source.toUpperCase()}_BASE_URL`] ?? `http://localhost:${DEFAULT_PORTS[source]}`;
}

// The feed+ledger trio polls by default. sheets (A5) is deliberately NOT in the default:
// it has no /events feed, so the surfaces this default drives — main.ts's feed-shaped
// interval backfill, the demo scripts — have nothing to poll there. A deployment opts a
// sheet in via INGEST_SOURCES, which also makes WEBHOOK_SECRET_SHEETS a boot requirement
// (assertWebhookSecrets runs over enabledSources) exactly where the source is on. The
// connector-seam CLIs (cli/backfill, cli/reconcile) route every enabled source through
// connectorFor, so an opted-in sheets source catches up and reconciles correctly there.
const DEFAULT_ENABLED: readonly Source[] = ["crm", "billing", "support"];

// Which sources this deployment actually polls/reconciles. Scripts pin this explicitly;
// code default is the feed trio (see above).
export function enabledSources(): Source[] {
  const raw = process.env.INGEST_SOURCES ?? DEFAULT_ENABLED.join(",");
  return raw.split(",").map((s) => s.trim()).filter(isSource);
}

export function ledgerPathFor(source: Source): string | undefined {
  return process.env[`LEDGER_PATH_${source.toUpperCase()}`];
}
