// Re-export shim: the ledger implementation lives in @switchboard/mock-core.
export {
  appendToLedger,
  readLedger,
  verifyLedgerChain,
  GENESIS_HASH,
  DEFAULT_LEDGER_HMAC_KEY,
  type LedgerEntry,
  type LedgerEntryInput,
} from "@switchboard/mock-core";
