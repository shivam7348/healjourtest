// Partner connectors for payments, communication, CRM, alerts and App Store webhooks.
// Each runs against the real partner when its credentials are set on the server, otherwise against
// the built-in sandbox partner (server/core/framework/sandbox-partners.ts). The mode is shown in the UI.

import { DEFAULT_RETRY, registerConnector, type ConnectorDefinition } from "../framework/connector.js";

const has = (...names: string[]) => names.every(n => Boolean(process.env[n]?.trim()));
const modes = new Map<string, "live" | "sandbox">();
export const connectorMode = (id: string) => modes.get(id) ?? "sandbox";
export const hubConnectorModes = () => Object.fromEntries(modes);

function add(def: Omit<ConnectorDefinition, "managedBy">, live: boolean) {
  modes.set(def.id, live ? "live" : "sandbox");
  registerConnector({ ...def, managedBy: "framework" });
}

// ---------- payments ----------
const rzpLive = has("RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET");
add({
  id: "razorpay", name: "Razorpay", family: "payments",
  description: "Payment links, payment webhooks, refunds and settlement reconciliation.",
  baseUrl: rzpLive ? "https://api.razorpay.com" : "mock://razorpay",
  defaultVersion: "v1", versions: ["v1"],
  auth: rzpLive ? { type: "basic", userEnv: "RAZORPAY_KEY_ID", passEnv: "RAZORPAY_KEY_SECRET" } : { type: "basic", userEnv: "RAZORPAY_KEY_ID", passEnv: "RAZORPAY_KEY_SECRET", sandboxUser: "rzp_test_sandbox", sandboxPass: "sandbox" },
  retry: DEFAULT_RETRY, rateLimit: { requests: 20, perMs: 1000 }, timeoutMs: 15_000,
  operations: {
    createPaymentLink: { method: "POST", description: "Create a payment link", paths: { v1: "/v1/payment_links" } },
    refund: { method: "POST", description: "Refund a payment (full or partial)", paths: { v1: "/v1/payments/{paymentId}/refund" } },
    settlements: { method: "GET", description: "Settlement report for reconciliation", paths: { v1: "/v1/settlements/recon/combined" } }
  }
}, rzpLive);

// HDFC SmartGATEWAY live paths must be confirmed against HDFC's merchant docs before switching on.
const hdfcLive = has("HDFC_BASE_URL", "HDFC_API_KEY", "HDFC_MERCHANT_ID");
add({
  id: "hdfc", name: "HDFC SmartGATEWAY", family: "payments",
  description: "Orders with payment links, refunds and settlements (sandbox until HDFC merchant onboarding).",
  baseUrl: hdfcLive ? process.env.HDFC_BASE_URL!.trim() : "mock://hdfc",
  defaultVersion: "v1", versions: ["v1"],
  auth: { type: "basic", userEnv: "HDFC_API_KEY", passEnv: "HDFC_MERCHANT_ID", sandboxUser: "hdfc_sandbox", sandboxPass: "sandbox" },
  retry: DEFAULT_RETRY, rateLimit: { requests: 10, perMs: 1000 }, timeoutMs: 15_000,
  operations: {
    createPaymentLink: { method: "POST", description: "Create an order with a payment link", paths: { v1: "/v1/orders" } },
    refund: { method: "POST", description: "Refund a payment", paths: { v1: "/v1/payments/{paymentId}/refund" } },
    settlements: { method: "GET", description: "Settlement report", paths: { v1: "/v1/settlements/recon/combined" } }
  }
}, hdfcLive);

// ---------- communication ----------
const exotelLive = has("EXOTEL_SID", "EXOTEL_API_KEY", "EXOTEL_API_TOKEN");
add({
  id: "exotel", name: "Exotel", family: "communication",
  description: "SMS (confirmations, reminders, report ready) and click-to-call between staff and patients.",
  baseUrl: exotelLive ? `https://${process.env.EXOTEL_SUBDOMAIN?.trim() || "api.exotel.com"}` : "mock://exotel",
  defaultVersion: "v1", versions: ["v1"],
  auth: { type: "basic", userEnv: "EXOTEL_API_KEY", passEnv: "EXOTEL_API_TOKEN", sandboxUser: "exotel_sandbox", sandboxPass: "sandbox" },
  retry: DEFAULT_RETRY, rateLimit: { requests: 10, perMs: 1000 }, timeoutMs: 15_000,
  operations: {
    sendSms: { method: "POST", bodyFormat: "form", description: "Send an SMS", paths: { v1: "/v1/Accounts/{sid}/Sms/send" } },
    connectCall: { method: "POST", bodyFormat: "form", description: "Connect staff to patient by phone", paths: { v1: "/v1/Accounts/{sid}/Calls/connect" } }
  }
}, exotelLive);

const gmailLive = has("GOOGLE_ACCESS_TOKEN");
add({
  id: "gmail", name: "Gmail", family: "communication",
  description: "Booking confirmation, reminder and report emails.",
  baseUrl: gmailLive ? "https://gmail.googleapis.com" : "mock://gmail",
  defaultVersion: "v1", versions: ["v1"],
  auth: { type: "bearer", secretEnv: "GOOGLE_ACCESS_TOKEN", sandboxValue: "sandbox-token" },
  retry: DEFAULT_RETRY, rateLimit: { requests: 10, perMs: 1000 }, timeoutMs: 15_000,
  operations: { sendEmail: { method: "POST", description: "Send an email", paths: { v1: "/gmail/v1/users/me/messages/send" } } }
}, gmailLive);

add({
  id: "gcal", name: "Google Calendar", family: "communication",
  description: "Puts home-collection visits on the staff calendar.",
  baseUrl: gmailLive ? "https://www.googleapis.com" : "mock://gcal",
  defaultVersion: "v3", versions: ["v3"],
  auth: { type: "bearer", secretEnv: "GOOGLE_ACCESS_TOKEN", sandboxValue: "sandbox-token" },
  retry: DEFAULT_RETRY, rateLimit: { requests: 10, perMs: 1000 }, timeoutMs: 15_000,
  operations: { createEvent: { method: "POST", description: "Create a calendar event", paths: { v3: "/calendar/v3/calendars/primary/events" } } }
}, gmailLive);

// ---------- CRM ----------
const lsqLive = has("LSQ_HOST", "LSQ_ACCESS_KEY", "LSQ_SECRET_KEY");
add({
  id: "leadsquared", name: "LeadSquared", family: "crm",
  description: "Pushes captured leads to the sales CRM.",
  baseUrl: lsqLive ? `https://${process.env.LSQ_HOST!.trim()}` : "mock://leadsquared",
  defaultVersion: "v2", versions: ["v2"],
  auth: { type: "query_keys", params: [{ name: "accessKey", env: "LSQ_ACCESS_KEY", sandboxValue: "sandbox" }, { name: "secretKey", env: "LSQ_SECRET_KEY", sandboxValue: "sandbox" }] },
  retry: DEFAULT_RETRY, rateLimit: { requests: 5, perMs: 1000 }, timeoutMs: 15_000,
  operations: { captureLead: { method: "POST", description: "Create or update a lead", paths: { v2: "/v2/LeadManagement.svc/Lead.Capture" } } }
}, lsqLive);

const metaLive = has("META_PAGE_TOKEN");
add({
  id: "meta-graph", name: "Meta Lead Ads (Graph API)", family: "crm",
  description: "Fetches the form answers for each lead ID that Meta's webhook sends.",
  baseUrl: metaLive ? "https://graph.facebook.com" : "mock://meta",
  defaultVersion: "v19.0", versions: ["v19.0"],
  auth: { type: "query_keys", params: [{ name: "access_token", env: "META_PAGE_TOKEN", sandboxValue: "sandbox" }] },
  retry: DEFAULT_RETRY, rateLimit: { requests: 10, perMs: 1000 }, timeoutMs: 15_000,
  operations: { getLead: { method: "GET", description: "Lead form answers", paths: { "v19.0": "/v19.0/{leadgenId}" } } }
}, metaLive);

// ---------- alerts and App Store ----------
const slackLive = has("ALERT_SLACK_WEBHOOK_URL");
add({
  id: "slack-alerts", name: "Slack alerts", family: "communication",
  description: "Posts integration alerts to the ops channel.",
  baseUrl: slackLive ? process.env.ALERT_SLACK_WEBHOOK_URL!.trim() : "mock://slack",
  defaultVersion: "v1", versions: ["v1"],
  auth: { type: "none" },
  retry: { ...DEFAULT_RETRY, maxAttempts: 3 }, rateLimit: { requests: 1, perMs: 1000 }, timeoutMs: 10_000,
  operations: { post: { method: "POST", description: "Post a message", paths: { v1: "@" } } }
}, slackLive);

add({
  id: "app-webhooks", name: "App Store webhooks", family: "app_store",
  description: "Delivers signed events to installed third-party apps.",
  baseUrl: "mock://app-receiver",
  defaultVersion: "v1", versions: ["v1"],
  auth: { type: "none" },
  retry: DEFAULT_RETRY, rateLimit: { requests: 20, perMs: 1000 }, timeoutMs: 10_000,
  operations: { deliver: { method: "POST", description: "Deliver an event to an app", paths: { v1: "@" } } }
}, false);
