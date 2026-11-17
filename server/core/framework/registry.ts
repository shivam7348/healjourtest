// Connectors known to the framework. Adding a partner = one definition here plus its mapping specs.

import { DEFAULT_RETRY, registerConnector } from "./connector.js";
import type { MappingSpec } from "./mapping.js";

/** Healjour's booking shape (what our forms produce). */
export const SAMPLE_BOOKING = {
  bookingId: "HJ-DEMO-0001",
  patient: { name: "  Rahul   Sharma ", phone: "+91 98765-43210", dob: "14/08/1993", gender: "M" },
  tests: ["CBC", "HBA1C"],
  collection: "home",
  amount: "1,250"
};

// v1 of the sandbox partner API: flat fields.
const ORDER_V1: MappingSpec = {
  name: "Healjour booking → Sandbox order (v1)",
  version: "v1",
  rules: [
    { to: "external_ref", from: "bookingId", required: true },
    { to: "patient_name", from: "patient.name", transform: "trim", required: true },
    { to: "mobile", from: "patient.phone", transform: "phone10", required: true },
    { to: "dob", from: "patient.dob", transform: "isoDate" },
    { to: "sex", from: "patient.gender", transform: "gender", default: "other" },
    { to: "test_codes", from: "tests", transform: "join" },
    { to: "amount", from: "amount", transform: "number" },
    { to: "source", const: "healjour" }
  ]
};

// v2 renamed and nested fields; both versions run side by side, chosen per call.
const ORDER_V2: MappingSpec = {
  name: "Healjour booking → Sandbox order (v2)",
  version: "v2",
  rules: [
    { to: "reference.healjourId", from: "bookingId", required: true },
    { to: "patient.fullName", from: "patient.name", transform: "trim", required: true },
    { to: "patient.mobile", from: "patient.phone", transform: "phone10", required: true },
    { to: "patient.dateOfBirth", from: "patient.dob", transform: "isoDate" },
    { to: "patient.gender", from: "patient.gender", transform: "gender", default: "other" },
    { to: "items", from: "tests" },
    { to: "collection.mode", from: "collection", transform: ["lower", "map:{\"home\":\"HOME_VISIT\",\"lab\":\"WALK_IN\"}"] },
    { to: "payment.amount", from: "amount", transform: "number" },
    { to: "meta.source", const: "healjour" }
  ]
};

export const MAPPING_EXAMPLES = { v1: ORDER_V1, v2: ORDER_V2 };
const FLABS_BASE = (process.env.FLABS_BASE_URL?.trim() || "https://v2.flabs.in").replace(/\/$/, "");

registerConnector({
  id: "partner-sandbox",
  name: "Partner Sandbox",
  family: "other",
  description: "Built-in test partner. Shows retries, rate limits, outages, idempotency, versions and replay without a real account.",
  baseUrl: "mock://sandbox",
  defaultVersion: "v2",
  versions: ["v1", "v2"],
  auth: { type: "api_key", header: "x-api-key", secretEnv: "SANDBOX_API_KEY", sandboxValue: "sandbox-key" },
  retry: { ...DEFAULT_RETRY, maxAttempts: 4, baseDelayMs: 250, maxDelayMs: 2000 },
  rateLimit: { requests: 5, perMs: 1000 },
  timeoutMs: 10_000,
  managedBy: "framework",
  operations: {
    createOrder: {
      method: "POST",
      description: "Create a lab order from a Healjour booking",
      paths: { v1: "/v1/orders", v2: "/v2/orders" },
      mapRequest: { v1: ORDER_V1, v2: ORDER_V2 }
    }
  }
});

// Flabs is listed so the registry shows every live partner. It still uses its own client
// (server/core/flabs/*); moving it onto callConnector() is the next migration step.
registerConnector({
  id: "flabs-crm",
  name: "Flabs CRM / LIS",
  family: "his_lis",
  description: "Leads, bookings, pre-bookings, test catalogue and 12 webhook events (results, reports).",
  baseUrl: FLABS_BASE,
  defaultVersion: "client-v1",
  versions: ["client-v1"],
  auth: { type: "oauth2_client_credentials", tokenUrl: `${FLABS_BASE}/client/auth/token`, clientIdEnv: "FLABS_CLIENT_ID", clientSecretEnv: "FLABS_SECRET_KEY" },
  retry: DEFAULT_RETRY,
  rateLimit: { requests: 10, perMs: 1000 },
  timeoutMs: 15_000,
  managedBy: "legacy",
  operations: {
    createLead: { method: "POST", description: "Create a lead or booking", paths: { "client-v1": "/client/crm/lead/create" } },
    createBill: { method: "POST", description: "Pre-booking (bill)", paths: { "client-v1": "/client/billing/create" } },
    listTests: { method: "GET", description: "Test catalogue", paths: { "client-v1": "/client/crm/tests" } }
  }
});
