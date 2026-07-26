export const SOURCES = ["crm", "billing", "support"] as const;
export type Source = (typeof SOURCES)[number];

export function isSource(v: string): v is Source {
  return (SOURCES as readonly string[]).includes(v);
}

const DEFAULT_PORTS: Record<Source, number> = { crm: 4001, billing: 4003, support: 4004 };

export function baseUrlFor(source: Source): string {
  return process.env[`${source.toUpperCase()}_BASE_URL`] ?? `http://localhost:${DEFAULT_PORTS[source]}`;
}

// Which sources this deployment actually polls/reconciles. Scripts pin this explicitly;
// code default is all three.
export function enabledSources(): Source[] {
  const raw = process.env.INGEST_SOURCES ?? SOURCES.join(",");
  return raw.split(",").map((s) => s.trim()).filter(isSource);
}

export function ledgerPathFor(source: Source): string | undefined {
  return process.env[`LEDGER_PATH_${source.toUpperCase()}`];
}
