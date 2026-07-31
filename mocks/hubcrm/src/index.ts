// Public surface of @switchboard/mock-hubcrm — everything the connector's oracle and
// other in-process consumers need.
export {
  createHubStore,
  type DeliverOptions,
  type DeliveryStats,
  type HubFaultPlan,
  type HubObjectType,
  type HubRecord,
  type HubStore,
  type HubStoreOptions,
  type ThinEvent,
} from "./store.js";
export { createHubcrmApp, type HubcrmApp, type HubcrmAppOptions } from "./server.js";
