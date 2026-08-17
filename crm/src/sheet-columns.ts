// Contact-shaped column mapping for the client's Google Sheet — the master contact list
// whose headers are HERS ("Name", "Contact #", "Met At"), in HER order. Pure module:
// no I/O, no database, no Google client. The transport that fetches the grid comes later;
// this layer only turns a header row + cell rows into the fields the proposer needs.
//
// PROVENANCE: the resolution discipline is adapted from
// `ingest/src/connectors/sheet-canonical.ts` (resolveHeaderMapping). `@switchboard/crm`
// must not import `@switchboard/ingest` (commit 69ad456 closed cross-workspace source
// imports), so the logic is copied and generified here, same as `crm/src/phone.ts` did for
// its origins. The ingest original is untouched.
//
// Carried over unchanged from the original:
//   · LANDMINE (binding, from A3's review): positions are resolved BY HEADER NAME on EVERY
//     fetch — never cached across snapshots. A cached positional mapping would pass every
//     mock test and break on the first real-world column insert/reorder. The returned
//     mapping is scoped to the single header row passed in; nothing may persist indices.
//   · alias lists per field, matched case-insensitively after trimming
//   · a column serves at most one field — first claim in map order wins on collisions
//   · loud refusal prints the headers actually seen; missing non-key columns degrade
//
// Deliberately CHANGED from the original — these are the contact-shaped semantics:
//   1. `phone` may claim MULTIPLE columns ("Phone" + "Phone 2", "Mobile" + "Landline"),
//      collected in sheet order (left to right) because DIAL ORDER IS ENTRY ORDER
//      (`crm/src/intake.ts`, 016's ordinal semantics). A cell may also hold several
//      numbers ("0917-123-4567 / 0918-555-1234"): split conservatively, normalize each via
//      the shipped `normalizePhone`, and surface anything unreadable as a per-row problem
//      (error return, never a throw, never a guess — `crm/src/phone.ts`'s contract).
//   2. The KEY rule is LAXER. Ingest refuses when email+client_name are unmappable; intake's
//      header states the opposite philosophy for contacts ("INTAKE REFUSES ALMOST NOTHING,
//      AND THAT IS THE DESIGN"). The SHEET is refused only when NONE of
//      {display_name, email, phone} can be mapped — that is not a contact list. Any ROW is
//      accepted, including one with no email and no phone; per-row gaps are the shipped
//      blocked-reason machinery's job (`no_email_address`, `no_phone_number`).
//
// 🚨 "" → null AT THIS BOUNDARY. `crm/src/opening.ts` branches on `displayName === null`
// to choose the nameless opening line; a sheet cell yields "", not null, and an empty name
// cell passed through raw would render "Hi , this is…" with identityUnverified NOT set.
// Every text field here normalizes empty/whitespace-only to null.

import {
  normalizePhone,
  isPhoneError,
  DEFAULT_REGION,
  type NormalizedPhone,
} from "./phone.js";

/** The contact vocabulary this mapper resolves. Alias seeds, extendable per tenant later. */
export type ContactField =
  | "display_name"
  | "email"
  | "phone"
  | "source_detail"
  | "looking_for"
  | "notes";

type SingleColumnField = Exclude<ContactField, "phone">;

export type ContactColumnMap = Readonly<Record<ContactField, readonly string[]>>;

export const CONTACT_COLUMN_MAP: ContactColumnMap = {
  display_name: ["name", "client name", "contact", "full name", "client"],
  email: ["email", "e-mail", "email address", "mail"],
  phone: [
    "phone",
    "mobile",
    "cell",
    "contact number",
    "contact #",
    "cp",
    "cp #",
    "tel",
    "telephone",
    "phone 2",
    "alt phone",
    "mobile 2",
  ],
  source_detail: ["met at", "source", "event", "referral", "referred by", "how we met"],
  looking_for: ["looking for", "interested in", "requirements", "notes on needs"],
  notes: ["notes", "comments", "remarks"],
};

/** A sheet where NONE of these can be mapped is not a contact list. ONE suffices — the
 *  laxer-than-ingest rule, per intake's design. */
export const CONTACT_KEY_FIELDS: readonly ContactField[] = ["display_name", "email", "phone"];

export interface ContactHeaderMapping {
  /** field → column index, valid ONLY for the header row it was resolved from. */
  positions: Partial<Record<SingleColumnField, number>>;
  /** EVERY column claimed by `phone`, in sheet order (left to right) — dial order. */
  phoneColumns: readonly number[];
  /** Mapped-in-config fields with no matching header (degradations, not failures). */
  missing: ContactField[];
}

/** Loud refusal: names the headers actually seen so she can fix the sheet, not guess. */
export interface SheetRefusal {
  error: string;
  headersSeen: readonly string[];
}

export type ContactColumnResolution = ContactHeaderMapping | SheetRefusal;

export function isSheetRefusal(r: ContactColumnResolution): r is SheetRefusal {
  return "error" in r;
}

/**
 * Resolve contact fields to column positions from the header row of ONE snapshot.
 * Re-resolve on every fetch; never persist the indices (see LANDMINE above).
 */
export function resolveContactColumns(
  header: readonly string[],
  map: ContactColumnMap = CONTACT_COLUMN_MAP,
): ContactColumnResolution {
  const normalized = header.map((h) => h.trim().toLowerCase());
  const positions: Partial<Record<SingleColumnField, number>> = {};
  const phoneColumns: number[] = [];
  const missing: ContactField[] = [];
  // A column serves at most one field (first claim in map order wins) — a pathological
  // header set cannot silently feed one cell into two fields.
  const claimed = new Set<number>();
  for (const [field, aliases] of Object.entries(map) as [ContactField, readonly string[]][]) {
    if (field === "phone") {
      // Multi-claim: EVERY unclaimed matching column, in sheet order.
      for (let i = 0; i < normalized.length; i++) {
        if (!claimed.has(i) && aliases.includes(normalized[i])) {
          phoneColumns.push(i);
          claimed.add(i);
        }
      }
      if (phoneColumns.length === 0) missing.push(field);
      continue;
    }
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
  if (
    positions.display_name === undefined &&
    positions.email === undefined &&
    phoneColumns.length === 0
  ) {
    return {
      error:
        `not a contact sheet: none of display_name/email/phone could be mapped. ` +
        `Headers seen: ${JSON.stringify(header)}`,
      headersSeen: header,
    };
  }
  return { positions, phoneColumns, missing };
}

/** A number in a cell that `normalizePhone` could not read. Surfaced, never guessed at,
 *  never dropped — mirrors phone.ts's error-return contract. */
export interface RowPhoneProblem {
  /** The segment as it appeared in the cell. */
  raw: string;
  /** normalizePhone's error text. */
  error: string;
}

export interface ContactRowFields {
  displayName: string | null;
  emailAddress: string | null;
  /** Normalized numbers in DIAL ORDER: sheet column order, then within-cell order. */
  phones: readonly NormalizedPhone[];
  /** Per-ROW problems. A row with problems is still a row — nothing here refuses it. */
  phoneProblems: readonly RowPhoneProblem[];
  sourceDetail: string | null;
  lookingFor: string | null;
  notes: string | null;
}

/** Empty/whitespace-only → null; otherwise trimmed. THE boundary rule (see header). */
function blankToNull(cell: string | undefined): string | null {
  if (cell === undefined) return null;
  const t = cell.trim();
  return t === "" ? null : t;
}

// Conservative in-cell separators only: slash, comma, semicolon, newline. Never hyphens
// or spaces — those live INSIDE numbers ("0917-123-4567", "+63 917 123 4567").
const CELL_SEPARATORS = /[/,;\n]+/;

/**
 * Turn one mapped row's raw cells into normalized contact fields. Accepts ANY row —
 * a row with no email and no phone is a capture with gaps, and the gaps are the shipped
 * blocked-reason machinery's problem, not this function's.
 */
export function contactRowFields(
  mapping: ContactHeaderMapping,
  cells: readonly string[],
  region: string = DEFAULT_REGION,
): ContactRowFields {
  const at = (field: SingleColumnField): string | null => {
    const i = mapping.positions[field];
    return i === undefined ? null : blankToNull(cells[i]);
  };

  const phones: NormalizedPhone[] = [];
  const phoneProblems: RowPhoneProblem[] = [];
  for (const col of mapping.phoneColumns) {
    const cell = cells[col];
    if (cell === undefined || cell.trim() === "") continue;
    // A cell with no separator is passed through UNSPLIT so `raw` stays byte-identical to
    // what she typed (phone.ts's raw contract); a multi-number cell yields trimmed segments.
    const segments = CELL_SEPARATORS.test(cell)
      ? cell.split(CELL_SEPARATORS).map((s) => s.trim()).filter((s) => s !== "")
      : [cell];
    for (const segment of segments) {
      const r = normalizePhone(segment, region);
      if (isPhoneError(r)) {
        phoneProblems.push({ raw: segment, error: r.error });
      } else {
        phones.push(r);
      }
    }
  }

  return {
    displayName: at("display_name"),
    emailAddress: at("email"),
    phones,
    phoneProblems,
    sourceDetail: at("source_detail"),
    lookingFor: at("looking_for"),
    notes: at("notes"),
  };
}
