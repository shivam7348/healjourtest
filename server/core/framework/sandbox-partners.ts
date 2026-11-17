// Sandbox versions of real partners (payments, messaging, email, calendar, CRM, alert channels, App Store receivers).
// Each answers like the real API does for the calls Healjour makes, so every flow can run end to end
// without accounts. Setting the real credentials switches a connector to the real partner (see hub/connectors.ts).

import { randomBytes } from "node:crypto";

type Req = { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: any };
type Res = { status: number; headers: Record<string, string>; data: unknown };
const json = (status: number, data: unknown): Res => ({ status, headers: {}, data });
const rid = (prefix: string) => `${prefix}_${randomBytes(7).toString("hex")}`;
const now = () => Math.floor(Date.now() / 1000);

// ---------- payments: shared state so refunds and settlements line up with links ----------
type SandboxPayment = { provider: string; linkId: string; paymentId?: string; amount: number; paidAt?: number; refunded: number; settleAmount?: number };
const payments = new Map<string, SandboxPayment>();         // by linkId
const byPaymentId = new Map<string, SandboxPayment>();

/** Called by the payment simulator when the "patient pays" in the sandbox. */
export function sandboxMarkPaid(provider: string, linkId: string, settleAdjust = 0): { paymentId: string; amount: number } | null {
  const p = payments.get(linkId);
  if (!p || p.provider !== provider) return null;
  p.paymentId = p.paymentId ?? rid("pay");
  p.paidAt = now();
  p.settleAmount = p.amount + settleAdjust;              // settleAdjust != 0 creates a reconciliation mismatch on purpose
  byPaymentId.set(p.paymentId, p);
  return { paymentId: p.paymentId, amount: p.amount };
}

function paymentsPartner(provider: "razorpay" | "hdfc", req: Req): Res {
  if (!String(req.headers.Authorization ?? "").startsWith("Basic ")) return json(401, { error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" } });
  const linkPath = provider === "razorpay" ? "/v1/payment_links" : "/v1/orders";
  if (req.method === "POST" && req.path === linkPath) {
    const amount = Number(req.body?.amount);
    if (!Number.isInteger(amount) || amount < 100) return json(400, { error: { code: "BAD_REQUEST_ERROR", description: "amount must be at least 100 paise" } });
    const linkId = rid(provider === "razorpay" ? "plink" : "ord");
    payments.set(linkId, { provider, linkId, amount, refunded: 0 });
    return json(200, provider === "razorpay"
      ? { id: linkId, amount, currency: "INR", status: "created", reference_id: req.body?.reference_id, short_url: `https://sandbox.pay.healjour/${linkId}` }
      : { order_id: linkId, amount, status: "NEW", payment_links: { web: `https://sandbox.pay.healjour/${linkId}` } });
  }
  const refund = /^\/v1\/payments\/([^/]+)\/refund$/.exec(req.path);
  if (req.method === "POST" && refund) {
    const p = byPaymentId.get(decodeURIComponent(refund[1]));
    if (!p) return json(400, { error: { code: "BAD_REQUEST_ERROR", description: "The payment id provided does not exist" } });
    const amount = Number(req.body?.amount ?? p.amount - p.refunded);
    if (amount <= 0 || p.refunded + amount > p.amount) return json(400, { error: { code: "BAD_REQUEST_ERROR", description: "The refund amount is more than the amount left to refund" } });
    p.refunded += amount;
    return json(200, { id: rid("rfnd"), payment_id: p.paymentId, amount, status: "processed", created_at: now() });
  }
  if (req.method === "GET" && req.path === "/v1/settlements/recon/combined") {
    const items = [...byPaymentId.values()].filter(p => p.provider === provider && p.paidAt).map(p => {
      const fee = Math.round((p.settleAmount ?? p.amount) * 0.02);
      const tax = Math.round(fee * 0.18);
      return { entity_id: p.paymentId, payment_link_id: p.linkId, type: "payment", amount: p.settleAmount ?? p.amount, fee, tax, debit: 0, credit: (p.settleAmount ?? p.amount) - fee - tax, settled_at: (p.paidAt ?? now()) + 86400, settlement_id: rid("setl") };
    });
    return json(200, { entity: "collection", count: items.length, items });
  }
  return json(404, { error: { code: "NOT_FOUND", description: `No sandbox route for ${req.method} ${req.path}` } });
}

// ---------- messaging (Exotel-style): SMS and click-to-call ----------
function messagingPartner(req: Req): Res {
  if (!String(req.headers.Authorization ?? "").startsWith("Basic ")) return json(401, { RestException: { Status: 401, Message: "Authentication failed" } });
  if (req.method === "POST" && /\/Sms\/send$/.test(req.path)) {
    const to = String(req.body?.To ?? "");
    if (!/^\d{10}$/.test(to.replace(/\D/g, "").slice(-10))) return json(400, { RestException: { Status: 400, Message: "Invalid 'To' number" } });
    if (to.endsWith("0000")) return json(400, { RestException: { Status: 400, Message: "Number is on the DND list" } });
    return json(200, { SMSMessage: { Sid: rid("sms"), Status: "queued", To: to, DateCreated: new Date().toISOString() } });
  }
  if (req.method === "POST" && /\/Calls\/connect$/.test(req.path)) {
    return json(200, { Call: { Sid: rid("call"), Status: "in-progress", From: req.body?.From, To: req.body?.To } });
  }
  return json(404, { RestException: { Status: 404, Message: "Not found" } });
}

// ---------- email (Gmail-style) and calendar (Google Calendar-style) ----------
function emailPartner(req: Req): Res {
  if (!String(req.headers.Authorization ?? "").startsWith("Bearer ")) return json(401, { error: { code: 401, message: "Invalid Credentials" } });
  if (req.method === "POST" && req.path === "/gmail/v1/users/me/messages/send") {
    // Like Gmail: the body is { raw: base64url(RFC 822 message) }; read the To: header from it.
    const raw = Buffer.from(String(req.body?.raw ?? ""), "base64url").toString("utf8");
    const to = /^To:\s*(.+)$/im.exec(raw)?.[1]?.trim() ?? "";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json(400, { error: { code: 400, message: "Invalid To header" } });
    return json(200, { id: rid("msg"), threadId: rid("thr"), labelIds: ["SENT"] });
  }
  return json(404, { error: { code: 404, message: "Not found" } });
}
function calendarPartner(req: Req): Res {
  if (!String(req.headers.Authorization ?? "").startsWith("Bearer ")) return json(401, { error: { code: 401, message: "Invalid Credentials" } });
  if (req.method === "POST" && req.path === "/calendar/v3/calendars/primary/events") {
    if (!req.body?.start?.dateTime) return json(400, { error: { code: 400, message: "Missing start time" } });
    const id = rid("evt");
    return json(200, { id, status: "confirmed", htmlLink: `https://calendar.sandbox.healjour/event/${id}`, summary: req.body?.summary });
  }
  return json(404, { error: { code: 404, message: "Not found" } });
}

// ---------- CRM (LeadSquared-style) ----------
function crmPartner(req: Req): Res {
  if (!req.query.accessKey || !req.query.secretKey) return json(401, { Status: "Error", ExceptionMessage: "Invalid access key" });
  if (req.method === "POST" && req.path === "/v2/LeadManagement.svc/Lead.Capture") {
    const fields = Array.isArray(req.body) ? req.body : [];
    const phone = fields.find((f: any) => f.Attribute === "Phone")?.Value;
    if (!phone) return json(400, { Status: "Error", ExceptionMessage: "Phone is required" });
    return json(200, { Status: "Success", Message: { Id: rid("lsq"), AffectedRows: 1 } });
  }
  return json(404, { Status: "Error", ExceptionMessage: "Not found" });
}

// ---------- alert channel (Slack-style incoming webhook) and App Store app receiver ----------
const chatLog: Array<{ at: string; text: string }> = [];
export const sandboxChatLog = () => chatLog.slice(-50).reverse();
function chatPartner(req: Req): Res {
  if (req.method === "POST") {
    chatLog.push({ at: new Date().toISOString(), text: String(req.body?.text ?? "") });
    if (chatLog.length > 200) chatLog.shift();
    return json(200, "ok");
  }
  return json(404, "not_found");
}
const appInbox: Array<{ at: string; app: string; event: string; signature: string }> = [];
export const sandboxAppInbox = () => appInbox.slice(-50).reverse();
function appReceiver(req: Req): Res {
  const sig = String(req.headers["X-Healjour-Signature"] ?? "");
  if (!sig.startsWith("sha256=")) return json(401, { error: "missing signature" });
  appInbox.push({ at: new Date().toISOString(), app: String(req.query.app ?? ""), event: String(req.body?.type ?? ""), signature: sig });
  if (appInbox.length > 200) appInbox.shift();
  return json(200, { received: true });
}

// ---------- Meta Graph API: lead details for a leadgen ID (Lead Ads webhooks carry only the ID) ----------
const SAMPLE_NAMES = ["Priya Nair", "Arjun Mehta", "Sana Khan", "Vikram Rao", "Neha Gupta"];
function metaPartner(req: Req): Res {
  if (!req.query.access_token) return json(401, { error: { message: "An access token is required", type: "OAuthException", code: 190 } });
  const m = /^\/v\d+\.\d+\/(\w+)$/.exec(req.path);
  if (req.method === "GET" && m) {
    const n = parseInt(m[1].replace(/\D/g, "").slice(-4) || "0", 10);
    return json(200, {
      id: m[1], created_time: new Date().toISOString(),
      field_data: [
        { name: "full_name", values: [SAMPLE_NAMES[n % SAMPLE_NAMES.length]] },
        { name: "phone_number", values: [`+9198${String(10000000 + n * 7919).slice(-8)}`] },
        { name: "email", values: [`lead${n}@example.com`] },
        { name: "city", values: ["Pune"] },
        { name: "which_test_are_you_looking_for?", values: ["Full body checkup"] }
      ]
    });
  }
  return json(404, { error: { message: "Unknown path" } });
}

export function partnerSandbox(host: string, req: Req): Res | null {
  switch (host) {
    case "meta": return metaPartner(req);
    case "razorpay": return paymentsPartner("razorpay", req);
    case "hdfc": return paymentsPartner("hdfc", req);
    case "exotel": return messagingPartner(req);
    case "gmail": return emailPartner(req);
    case "gcal": return calendarPartner(req);
    case "leadsquared": return crmPartner(req);
    case "slack": return chatPartner(req);
    case "app-receiver": return appReceiver(req);
    default: return null;
  }
}
