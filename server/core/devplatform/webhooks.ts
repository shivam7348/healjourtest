// Developer webhooks: Healjour POSTs signed JSON events to URLs the API apps register.
//
// Signature   X-Healjour-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
// Safety      Only public https:// URLs. The host is resolved and private, loopback, link-local and
//             metadata addresses are refused, at registration and again before every delivery (SSRF).
// Retries     Up to 3 attempts (now, +10 s, +60 s). Every attempt is kept in the delivery log.

import { createHmac, randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { getStore } from "../store.js";
import { API_CLIENTS, newId, type ApiClient } from "./platform.js";

export const WEBHOOK_EVENTS = {
  "booking.created": "A booking was created (by your app, or sent to your lab).",
  "booking.status_changed": "A booking moved to a new status (accepted, sample collected, processing, report ready, completed, rejected, cancelled).",
  "booking.results_updated": "Test results were entered or changed.",
  "booking.report_uploaded": "A report file was uploaded and can be downloaded.",
  "booking.note_added": "A note was added to the booking timeline."
} as const;
export type WebhookEvent = keyof typeof WEBHOOK_EVENTS;
export const isWebhookEvent = (e: string): e is WebhookEvent => Object.hasOwn(WEBHOOK_EVENTS, e);

export type Webhook = { id: string; clientId: string; url: string; events: WebhookEvent[]; secret: string; active: boolean; createdAt: string; lastDeliveryAt?: string; lastStatus?: number | string };
type Delivery = { id: string; webhookId: string; clientId: string; event: string; eventId: string; attempt: number; at: string; status: number | string; ms: number; ok: boolean; error?: string };

export const WEBHOOKS = "apiWebhooks";
const DELIVERIES = "apiWebhookDeliveries";
const MAX_PER_APP = 10;

// ---------- SSRF protection ----------
function privateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return privateIp(v6.slice(7));
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb") || v6.startsWith("ff");
}
/** null if the URL is a safe public https endpoint, otherwise the reason. */
export async function unsafeUrlReason(raw: string): Promise<string | null> {
  let url: URL;
  try { url = new URL(raw); } catch { return "Not a valid URL."; }
  if (url.protocol !== "https:") return "Webhook URLs must use https://.";
  if (url.username || url.password) return "Do not put credentials in the URL.";
  if (url.port && url.port !== "443") return "Use the standard https port (443).";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) return "Local or internal hosts are not allowed.";
  try {
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
    if (!addrs.length) return "The host does not resolve.";
    if (addrs.some(a => privateIp(a.address))) return "The host points to a private or internal address.";
  } catch { return "The host does not resolve."; }
  return null;
}

// ---------- registry ----------
export const listWebhooks = (clientId: string) => getStore().docList<Webhook>(WEBHOOKS, { clientId });
export const publicWebhook = ({ secret: _s, ...w }: Webhook) => w;

export async function addWebhook(clientId: string, url: string, events: WebhookEvent[]) {
  if ((await listWebhooks(clientId)).length >= MAX_PER_APP) return { ok: false as const, error: `An app can have at most ${MAX_PER_APP} webhooks.` };
  const bad = await unsafeUrlReason(url);
  if (bad) return { ok: false as const, error: bad };
  const hook: Webhook = { id: newId("wh"), clientId, url, events: [...new Set(events)], secret: `whsec_${randomBytes(24).toString("base64url")}`, active: true, createdAt: new Date().toISOString() };
  await getStore().docPut(WEBHOOKS, hook);
  return { ok: true as const, webhook: hook };
}
export async function removeWebhook(clientId: string, id: string) {
  const hook = await getStore().docGet<Webhook>(WEBHOOKS, id);
  if (!hook || hook.clientId !== clientId) return false;
  await getStore().docDelete(WEBHOOKS, id);
  return true;
}
export async function recentDeliveries(clientId: string, limit = 50) {
  return (await getStore().docList<Delivery>(DELIVERIES, { clientId })).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

// ---------- delivery ----------
export function signPayload(secret: string, body: string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

async function deliver(hook: Webhook, event: string, eventId: string, body: string, attempt: number): Promise<void> {
  const started = Date.now();
  let status: number | string = "error", error: string | undefined;
  const bad = await unsafeUrlReason(hook.url);
  if (bad) { status = "blocked"; error = bad; }
  else {
    try {
      const res = await fetch(hook.url, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
        headers: {
          "Content-Type": "application/json", "User-Agent": "Healjour-Webhooks/1.0",
          "X-Healjour-Event": event, "X-Healjour-Delivery": eventId, "X-Healjour-Signature": signPayload(hook.secret, body)
        },
        body
      });
      status = res.status;
      if (!res.ok) error = `Responded ${res.status}`;
    } catch (e) { error = e instanceof Error ? e.message : "Request failed"; status = "timeout"; }
  }
  const ok = typeof status === "number" && status >= 200 && status < 300;
  const store = getStore();
  await store.docPut<Delivery>(DELIVERIES, { id: newId("dlv"), webhookId: hook.id, clientId: hook.clientId, event, eventId, attempt, at: new Date().toISOString(), status, ms: Date.now() - started, ok, ...(error ? { error } : {}) });
  await store.docPut(WEBHOOKS, { ...hook, lastDeliveryAt: new Date().toISOString(), lastStatus: status });
  if (!ok && status !== "blocked" && attempt < 3) {
    const wait = attempt === 1 ? 10_000 : 60_000;
    setTimeout(() => { void deliver(hook, event, eventId, body, attempt + 1).catch(() => undefined); }, wait).unref?.();
  }
}

/**
 * Sends an event to every active webhook (subscribed to it) of the given apps.
 * Who receives a booking event: the partner app that created the booking, and the lab apps of that booking's lab.
 */
export async function emitEvent(event: WebhookEvent, data: unknown, audience: { clientIds?: string[]; labId?: string }) {
  try {
    const store = getStore();
    const ids = new Set(audience.clientIds ?? []);
    if (audience.labId) for (const c of await store.docList<ApiClient>(API_CLIENTS, { kind: "lab", labId: audience.labId })) if (c.active) ids.add(c.clientId);
    if (!ids.size) return;
    const eventId = newId("evt");
    const body = JSON.stringify({ id: eventId, event, createdAt: new Date().toISOString(), data });
    for (const clientId of ids) {
      for (const hook of await listWebhooks(clientId)) {
        if (hook.active && hook.events.includes(event)) void deliver(hook, event, eventId, body, 1).catch(() => undefined);
      }
    }
  } catch (e) { console.warn("Webhook emit failed:", e); }
}

/** A sample event to one webhook, from the console's "Send test" button. */
export async function sendTest(hook: Webhook) {
  const eventId = newId("evt");
  const body = JSON.stringify({ id: eventId, event: "ping", createdAt: new Date().toISOString(), data: { message: "Hello from Healjour. Your webhook works." } });
  await deliver(hook, "ping", eventId, body, 3);
  return (await recentDeliveries(hook.clientId, 1))[0];
}
