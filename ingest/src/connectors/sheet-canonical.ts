// Canonical form for the sheet-snapshot connector (Task A4): header mapping, canonical
// row content, serialization, and the content hash that MANUFACTURES idempotency for a
// source that has no events, no ids, and no clock of its own.
//
// The mock sheet's grid is stringly-typed and mutable in place; nothing about a row is
// stable except the row-attached developer-metadata key (rowKey). Everything else — ids,
// change detection, dedupe — is derived here from row CONTENT, so it must be canonical:
// same logical content ⇒ same bytes ⇒ same hash ⇒ same event_id ⇒ duplicate at the door.

import { createHash } from "node:crypto";

/** The source name sheet events are ingested under. Deliberately NOT added to the
 *  `SOURCES` union in sources.ts: that union is the legacy feed+ledger deployment set
 *  (webhook routes, CLI iteration, per-source env vars); this connector needs none of it.
 */
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
  throw new Error("not implemented (A4 RED)");
}

/** Canonical row content: { canonicalField: rawCellString } for every mapped, NON-EMPTY
 *  cell. Empty cells mean "absent" (a sheet renders missing as ""), matching the
 *  contract's required:false handling — and keeping a later fill-in a real content change. */
export function canonicalRowContent(mapping: HeaderMapping, cells: readonly string[]): Record<string, string> {
  throw new Error("not implemented (A4 RED)");
}

/** Deterministic deep-key-sorted JSON — the connector's canonical serialization. Used for
 *  the content hash AND as the event's wire form (rawBody): the connector IS the event's
 *  origin, so its canonical bytes are the closest thing to wire custody that exists
 *  (2b-D4 semantics for connector-born events). */
export function canonicalStringify(value: unknown): string {
  throw new Error("not implemented (A4 RED)");
}

/** Content hash over the CANONICAL serialized row content (never raw header labels). */
export function contentHash(content: Record<string, string>): string {
  throw new Error("not implemented (A4 RED)");
}

/** Conservative amount parsing (decision 5): strict formats only — a plain non-negative
 *  integer or decimal with 1–2 places, in string arithmetic (no float rounding). Anything
 *  else returns null and the caller passes the RAW string through as amount_cents, so the
 *  field contract quarantines it with a reason naming the field: a messy human row becomes
 *  a replayable quarantine entry, never a silent skip or a guessed number. */
export function parseAmountToCents(raw: string): number | null {
  throw new Error("not implemented (A4 RED)");
}
