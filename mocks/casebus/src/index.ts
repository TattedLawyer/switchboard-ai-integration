// Public surface of @switchboard/mock-casebus — everything the connector's oracle
// (ingest/test/bus-replay-oracle.test.ts) and other in-process consumers need.
export {
  createStream,
  CorruptedReplayIdError,
  REPLAY_PRESETS,
  type BusEvent,
  type FetchResult,
  type ReplayPreset,
  type StreamOptions,
  type StreamState,
} from "./stream.js";
export { createCasebusApp, type CasebusApp, type CasebusAppOptions } from "./server.js";
