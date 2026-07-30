// Public surface of @switchboard/mock-sheets — the connector slice's (A4) compile-time
// interface to this mock. Everything the connector or the A5 oracle needs is exported
// here; internals (journal mechanics, plan mixes) stay reachable only through these types.

export { COL, SHEET_HEADER, createRowSource, editValueSource, type RowContentSource } from "./seed.js";
export {
  createSheet,
  METADATA_CHAR_CAP,
  type AppliedEdit,
  type EditOp,
  type EditOpType,
  type Grid,
  type JournalEntry,
  type RowKeyMapEntry,
  type SheetRow,
  type SheetSnapshot,
  type SheetState,
} from "./sheet.js";
export {
  createEditor,
  FAULT_PLANS,
  FREEHAND_DATES,
  GARBAGE_CURRENCIES,
  type Editor,
  type FaultPlanName,
  type HumanEdit,
} from "./editor.js";
export {
  createSheetsApp,
  type Read429Options,
  type SheetsApp,
  type SheetsAppOptions,
} from "./server.js";
export {
  createTrigger,
  type SheetNotification,
  type SheetTrigger,
  type TriggerOptions,
  type TriggerStats,
} from "./trigger.js";
