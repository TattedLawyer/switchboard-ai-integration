// Canonical form for the sheet-snapshot connector (Task A4): header mapping, canonical
// row content, serialization, and the content hash that MANUFACTURES idempotency for a
// source that has no events, no ids, and no clock of its own.
//
// The mock sheet's grid is stringly-typed and mutable in place; nothing about a row is
// stable except the row-attached developer-metadata key (rowKey). Everything else — ids,
// change detection, dedupe — is derived here from row CONTENT, so it must be canonical:
// same logical content ⇒ same bytes ⇒ same hash ⇒ same event_id ⇒ duplicate at the door.

import { createHash } from "node:crypto";

/** The source name sheet events are ingested under. A4 kept it out of the `SOURCES`
 *  union (the connector needed none of the deployment surface then); A5 registered it —
 *  "sheets" is now a member of `SOURCES`, with `SHEETS_BASE_URL`/port 4005 conventions,
 *  `WEBHOOK_SECRET_SHEETS` for the nudge door, and a registry arm in connectors/index.ts.
 *  This constant stays the single spelling both sides share. */
export const SHEET_SOURCE = "sheets";

/** The connector's stable vocabulary. Events carry THESE names, never raw header labels —
 *  the content hash is computed over canonical fields, so a header rename inside the alias
 *  map changes nothing downstream (test obligation 7 pins this: hashing raw labels would
 *  rewrite every event_id on every cosmetic rename). */
export type CanonicalField =
  | "client_name"
  | "email"
  | "company"
  | "deal"
  | "amount_cents"
  | "currency"
  | "status"
  | "close_date"
  | "notes";

export type ColumnMap = Readonly<Record<CanonicalField, readonly string[]>>;

/**
 * Explicit header-mapping config (design decision 4): canonical field → accepted header
 * names, matched case-insensitively after trimming. Aliases cover the human drift the mock
 * editor models (HEADER_VARIANTS) plus obvious real-world spellings. Unmapped sheet
 * columns are ignored; a mapped field absent from the sheet degrades to absent-in-events.
 */
export const SHEET_COLUMN_MAP: ColumnMap = {
  client_name: ["client name", "client", "name"],
  email: ["email", "e-mail", "email address"],
  company: ["company", "company name"],
  deal: ["deal", "deal name"],
  amount_cents: ["amount", "amt", "deal value", "deal value (php)", "value"],
  currency: ["currency", "ccy"],
  status: ["status", "stage", "deal status"],
  close_date: ["close date", "closing", "date closed"],
  notes: ["notes", "note", "comments"],
};

/** The identity spine of a row. A sheet where these cannot be mapped is not a book of
 *  business we can ingest — catchUp must fail loudly rather than guess (decision 4). */
export const KEY_FIELDS: readonly CanonicalField[] = ["email", "client_name"];

export interface HeaderMapping {
  /** canonical field → column index, valid ONLY for the Grid it was resolved from. */
  positions: Partial<Record<CanonicalField, number>>;
  /** Mapped-in-config fields with no matching header in this snapshot (degradations). */
  missing: CanonicalField[];
}

/**
 * Resolve canonical fields to column positions from the header row of ONE snapshot.
 *
 * LANDMINE (carried from A3's review, binding): positions are resolved BY HEADER NAME on
 * EVERY fetch — never cached across snapshots. The mock deliberately does not model column
 * reorder (renames only, positions fixed), so a connector that cached positional mappings
 * would pass every mock test and break on the first real-world column insert/reorder. The
 * returned mapping is scoped to the single Grid whose header was passed in; callers must
 * re-resolve per snapshot and nothing may persist the indices.
 */
export function resolveHeaderMapping(header: readonly string[], map: ColumnMap = SHEET_COLUMN_MAP): HeaderMapping {
  const normalized = header.map((h) => h.trim().toLowerCase());
  const positions: Partial<Record<CanonicalField, number>> = {};
  const missing: CanonicalField[] = [];
  // A column serves at most one canonical field (first claim in map order wins) — so a
  // pathological header set cannot silently feed one cell into two fields.
  const claimed = new Set<number>();
  for (const [field, aliases] of Object.entries(map) as [CanonicalField, readonly string[]][]) {
    let found = -1;
    for (let i = 0; i < normalized.length; i++) {
      if (!claimed.has(i) && aliases.includes(normalized[i])) {
        found = i;
        break;
      }
    }
    if (found === -1) {
      missing.push(field);
    } else {
      positions[field] = found;
      claimed.add(found);
    }
  }
  return { positions, missing };
}

/** Canonical row content: { canonicalField: rawCellString } for every mapped, NON-EMPTY
 *  cell. Empty cells mean "absent" (a sheet renders missing as ""), matching the
 *  contract's required:false handling — and keeping a later fill-in a real content change. */
export function canonicalRowContent(mapping: HeaderMapping, cells: readonly string[]): Record<string, string> {
  const content: Record<string, string> = {};
  for (const [field, index] of Object.entries(mapping.positions) as [CanonicalField, number][]) {
    const value = cells[index];
    if (value !== undefined && value !== "") content[field] = value;
  }
  return content;
}

/** Deterministic deep-key-sorted JSON — the connector's canonical serialization. Used for
 *  the content hash AND as the event's wire form (rawBody): the connector IS the event's
 *  origin, so its canonical bytes are the closest thing to wire custody that exists
 *  (2b-D4 semantics for connector-born events). */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Content hash over the CANONICAL serialized row content (never raw header labels).
 *  sha256 truncated to 16 hex chars: collisions only matter WITHIN one rowKey's content
 *  history (the rowKey rides in the event_id beside it), where 64 bits is beyond ample. */
export function contentHash(content: Record<string, string>): string {
  return createHash("sha256").update(canonicalStringify(content)).digest("hex").slice(0, 16);
}

// Strict shapes only: a plain non-negative integer or a decimal with 1–2 places. No
// thousands separators, no currency glyphs, no signs — those pass through unparsed.
const AMOUNT_SHAPE = /^(\d+)(?:\.(\d{1,2}))?$/;

/** Conservative amount parsing (decision 5): strict formats only, in integer arithmetic
 *  (no float rounding — 1234.56 must become exactly 123456). Anything else returns null
 *  and the caller passes the RAW string through as amount_cents, so the field contract
 *  quarantines it with a reason naming the field: a messy human row becomes a replayable
 *  quarantine entry, never a silent skip or a guessed number. */
export function parseAmountToCents(raw: string): number | null {
  const m = AMOUNT_SHAPE.exec(raw.trim());
  if (m === null) return null;
  // 13 digits of whole units keeps cents comfortably inside Number.isSafeInteger; a
  // longer digit string has already lost exactness at Number() and is not trustworthy.
  if (m[1].length > 13) return null;
  const whole = Number(m[1]);
  const frac = m[2] === undefined ? 0 : Number(m[2].padEnd(2, "0"));
  const cents = whole * 100 + frac;
  return Number.isSafeInteger(cents) ? cents : null;
}
