// Public surface of @switchboard/mock-stripefeed — everything the connector's oracle
// (ingest/test/stripe-feed-oracle.test.ts) and other in-process consumers need.
export { createFeed, UnknownCursorError, type FeedEvent, type FeedOptions, type FeedState } from "./feed.js";
export { createStripeFeedApp, type StripeFeedApp, type StripeFeedAppOptions } from "./server.js";
