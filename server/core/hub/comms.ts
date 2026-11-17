// Communication: SMS (Exotel), email (Gmail), calendar (Google Calendar), click-to-call and a simple IVR.
// Appointment reminders are scheduled from the booking calendar and sent by the dispatcher.
// Delivery is tracked from provider status callbacks; a failed SMS falls back to email when we have one.
// Phone numbers and message text are stored encrypted.

import { createHash } from "node:crypto";
import { getStore } from "../store.js";
import { callConnector, newId } from "../framework/connector.js";
import { blindIndex, decrypt, encrypt, mask } from "../compliance/crypto.js";
import type { Appointment } from "../models.js";
import { publicBaseUrl } from "../public-url.js";

export type Channel = "sms" | "email";
export type TemplateId = "booking_confirmation" | "reminder" | "report_ready";
export type Message = {
  id: string; channel: Channel; template: TemplateId; toEnc: string; toIndex: string; toMasked: string;
  bodyEnc: string; subject?: string; bookingRef?: string;
  status: "scheduled" | "sent" | "delivered" | "failed"; providerId?: string; error?: string;
  fallbackOf?: string; fallbackEmailEnc?: string; scheduledFor?: string; sentAt?: string;
  createdAt: string; events: Array<{ at: string; status: string; detail: string }>;
};
export type CallLogEntry = { id: string; at: string; kind: "click_to_call" | "ivr"; fromMasked: string; toMasked: string; status: string; detail: string; providerId?: string };

const MESSAGES = "messages";
const CALLS = "callLogs";
const SETTINGS = "commsSettings";

export const DEFAULT_TEMPLATES: Record<TemplateId, { subject: string; text: string }> = {
  booking_confirmation: { subject: "Your Healjour booking {bookingRef} is confirmed", text: "Hi {name}, your Healjour booking {bookingRef} is confirmed for {when}. Tests: {tests}." },
  reminder: { subject: "Reminder: sample collection {when}", text: "Reminder: sample collection for booking {bookingRef} is at {when}. Please follow any fasting advice you were given." },
  report_ready: { subject: "Your report is ready", text: "Hi {name}, your report for booking {bookingRef} is ready. {link}" }
};
export type IvrConfig = { greeting: string; options: Array<{ digit: string; label: string; target: string }> };
const DEFAULT_IVR: IvrConfig = {
  greeting: "Welcome to Healjour. Press 1 to book a test, 2 for your reports, 3 to talk to our team.",
  options: [
    { digit: "1", label: "Book a test", target: "Bookings desk" },
    { digit: "2", label: "Reports", target: "Reports desk" },
    { digit: "3", label: "Talk to the team", target: "Customer care" }
  ]
};

export async function getCommsSettings() {
  const doc = await getStore().docGet<{ id: string; templates: typeof DEFAULT_TEMPLATES; ivr: IvrConfig }>(SETTINGS, "default");
  return { templates: { ...DEFAULT_TEMPLATES, ...(doc?.templates ?? {}) }, ivr: doc?.ivr ?? DEFAULT_IVR };
}
export async function saveCommsSettings(input: { templates?: typeof DEFAULT_TEMPLATES; ivr?: IvrConfig }) {
  const current = await getCommsSettings();
  const next = { id: "default", templates: input.templates ?? current.templates, ivr: input.ivr ?? current.ivr };
  await getStore().docPut(SETTINGS, next);
  return next;
}

const render = (text: string, vars: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
const whenText = (iso?: string) => (iso ? new Date(iso).toLocaleString("en-IN", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "the agreed time");

/** RFC 822 email, base64url, as the Gmail API expects. */
function gmailRaw(to: string, subject: string, text: string) {
  const from = process.env.EMAIL_FROM?.trim() || "Healjour <no-reply@healjour.example>";
  const msg = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "", text].join("\r\n");
  return Buffer.from(msg, "utf8").toString("base64url");
}

export function viewMessage(m: Message) {
  return {
    id: m.id, channel: m.channel, template: m.template, to: m.toMasked, subject: m.subject, text: decrypt<string>(m.bodyEnc),
    bookingRef: m.bookingRef, status: m.status, providerId: m.providerId, error: m.error, fallbackOf: m.fallbackOf,
    scheduledFor: m.scheduledFor, sentAt: m.sentAt, createdAt: m.createdAt, events: m.events
  };
}

/** Sends a stored message now. A failed SMS falls back to email if the patient has an email. */
async function deliver(m: Message): Promise<Message> {
  const store = getStore();
  const to = decrypt<string>(m.toEnc);
  const text = decrypt<string>(m.bodyEnc);
  const result = m.channel === "sms"
    ? await callConnector("exotel", "sendSms", {
        params: { sid: process.env.EXOTEL_SID?.trim() || "sandbox" },
        body: { From: process.env.EXOTEL_SENDER_ID?.trim() || "HEALJR", To: to, Body: text, StatusCallback: publicBaseUrl() ? `${publicBaseUrl()}/api/webhooks/comms/exotel/${commsToken()}` : "" },
        idempotencyKey: `msg-${m.id}`
      })
    : await callConnector("gmail", "sendEmail", { body: { raw: gmailRaw(to, m.subject ?? "Healjour", text) }, idempotencyKey: `msg-${m.id}` });
  const now = new Date().toISOString();
  if (result.ok) {
    const d = result.data as { SMSMessage?: { Sid: string }; id?: string };
    m.status = "sent"; m.providerId = d.SMSMessage?.Sid ?? d.id; m.sentAt = now; m.error = undefined;
    m.events.push({ at: now, status: "sent", detail: `Accepted by ${m.channel === "sms" ? "Exotel" : "Gmail"} (${m.providerId})` });
  } else {
    m.status = "failed"; m.error = result.error;
    m.events.push({ at: now, status: "failed", detail: result.error ?? "Provider error" });
  }
  await store.docPut(MESSAGES, m);
  if (m.status === "failed" && m.channel === "sms" && m.fallbackEmailEnc) {
    await queueMessage({ channel: "email", to: decrypt<string>(m.fallbackEmailEnc), template: m.template, text, subject: m.subject, bookingRef: m.bookingRef, fallbackOf: m.id, sendNow: true });
  }
  return m;
}

export async function queueMessage(input: {
  channel: Channel; to: string; template: TemplateId; vars?: Record<string, string>; text?: string; subject?: string;
  bookingRef?: string; fallbackEmail?: string; fallbackOf?: string; scheduledFor?: string; sendNow?: boolean; id?: string;
}) {
  const store = getStore();
  const { templates } = await getCommsSettings();
  const t = templates[input.template];
  const text = input.text ?? render(t.text, input.vars ?? {});
  const subject = input.subject ?? render(t.subject, input.vars ?? {});
  const id = input.id ?? newId("msg");
  if (input.id && await store.docGet(MESSAGES, input.id)) return null; // already scheduled (reminders are scheduled once)
  const m: Message = {
    id, channel: input.channel, template: input.template, toEnc: encrypt(input.to),
    toIndex: blindIndex(input.channel === "sms" ? "phone" : "email", input.to), toMasked: input.channel === "sms" ? mask(input.to) : input.to.replace(/^(.).*(@.*)$/, "$1***$2"),
    bodyEnc: encrypt(text), subject: input.channel === "email" ? subject : undefined, bookingRef: input.bookingRef,
    status: "scheduled", fallbackOf: input.fallbackOf, ...(input.fallbackEmail ? { fallbackEmailEnc: encrypt(input.fallbackEmail) } : {}),
    scheduledFor: input.scheduledFor, createdAt: new Date().toISOString(),
    events: [{ at: new Date().toISOString(), status: "scheduled", detail: input.scheduledFor ? `Due ${input.scheduledFor}` : "Send now" }]
  };
  await store.docPut(MESSAGES, m);
  return input.sendNow || !input.scheduledFor ? deliver(m) : m;
}

/** Sends every scheduled message that is due. Run by the dispatcher (cron) or by hand. */
export async function dispatchDue() {
  const now = Date.now();
  const due = (await getStore().docList<Message>(MESSAGES, { status: "scheduled" })).filter(m => !m.scheduledFor || Date.parse(m.scheduledFor) <= now);
  let sent = 0, failed = 0;
  for (const m of due) { const r = await deliver(m); r.status === "failed" ? failed++ : sent++; }
  return { due: due.length, sent, failed };
}

/** Schedules 24 h and 2 h SMS reminders for upcoming calendar bookings (once per booking and offset). */
export async function scheduleReminders() {
  const appointments = await getStore().listAppointments();
  const now = Date.now();
  let created = 0;
  for (const a of appointments) {
    if (!a.scheduledAt || !a.contact || a.status === "cancelled" || a.status === "done") continue;
    const at = Date.parse(a.scheduledAt);
    if (at < now || at - now > 3 * 86_400_000) continue;
    for (const hours of [24, 2]) {
      const sendAt = at - hours * 3_600_000;
      if (sendAt < now - 15 * 60_000) continue;          // too late for this reminder
      const m = await queueMessage({
        id: `rem-${a.id}-${hours}h`, channel: "sms", to: a.contact, template: "reminder", bookingRef: a.integratorID,
        vars: { name: a.patientName, bookingRef: a.integratorID, when: whenText(a.scheduledAt), tests: a.tests.join(", ") },
        scheduledFor: new Date(Math.max(sendAt, now)).toISOString()
      });
      if (m) created++;
    }
  }
  return { created };
}

/** Delivery report from the SMS provider (Exotel StatusCallback). */
export async function handleDeliveryReport(providerId: string, status: string, detail = "") {
  const store = getStore();
  const m = (await store.docList<Message>(MESSAGES, { providerId }))[0];
  if (!m) return false;
  const s = status.toLowerCase();
  const next = s === "sent" || s === "delivered" ? "delivered" : s.includes("fail") || s === "undelivered" ? "failed" : null;
  if (!next) return true;
  m.status = next;
  if (next === "failed") m.error = detail || "Not delivered";
  m.events.push({ at: new Date().toISOString(), status: next, detail: detail || `Provider status: ${status}` });
  await store.docPut(MESSAGES, m);
  if (next === "failed" && m.channel === "sms" && m.fallbackEmailEnc) {
    await queueMessage({ channel: "email", to: decrypt<string>(m.fallbackEmailEnc), template: m.template, text: decrypt<string>(m.bodyEnc), bookingRef: m.bookingRef, fallbackOf: m.id, sendNow: true });
  }
  return true;
}

/** Token in the callback URLs (Exotel does not sign its callbacks). */
export const commsToken = () => process.env.COMMS_WEBHOOK_TOKEN?.trim() || createHash("sha256").update(`healjour-comms:${process.env.DATA_ENCRYPTION_KEY ?? "dev"}`).digest("hex").slice(0, 24);

export async function addToCalendar(a: Appointment) {
  if (!a.scheduledAt) return { ok: false, error: "The booking has no time yet." };
  const start = new Date(a.scheduledAt);
  const end = new Date(start.getTime() + 30 * 60_000);
  const result = await callConnector("gcal", "createEvent", {
    body: { summary: `Sample collection: ${a.patientName || "patient"}`, description: `Booking ${a.integratorID}. Tests: ${a.tests.join(", ") || "—"}.${a.address ? ` Address: ${a.address}` : ""}`, start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } },
    idempotencyKey: `cal-${a.id}-${a.scheduledAt}`
  });
  return result.ok ? { ok: true, link: (result.data as { htmlLink?: string }).htmlLink } : { ok: false, error: result.error };
}

/** .ics file for any calendar app (works without Google). */
export function appointmentIcs(a: Appointment) {
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const start = new Date(a.scheduledAt ?? Date.now());
  const end = new Date(start.getTime() + 30 * 60_000);
  const esc = (s: string) => s.replace(/[\\;,]/g, m => `\\${m}`).replace(/\n/g, "\\n");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Healjour//Bookings//EN", "BEGIN:VEVENT",
    `UID:${a.id}@healjour`, `DTSTAMP:${fmt(new Date())}`, `DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`,
    `SUMMARY:${esc(`Sample collection: ${a.patientName || "patient"}`)}`, `DESCRIPTION:${esc(`Booking ${a.integratorID}. Tests: ${a.tests.join(", ")}`)}`,
    ...(a.address ? [`LOCATION:${esc(a.address)}`] : []), "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}

export async function clickToCall(staffPhone: string, patientPhone: string, bookingRef?: string) {
  const result = await callConnector("exotel", "connectCall", {
    params: { sid: process.env.EXOTEL_SID?.trim() || "sandbox" },
    body: { From: staffPhone, To: patientPhone, CallerId: process.env.EXOTEL_CALLER_ID?.trim() || "sandbox" }
  });
  const entry: CallLogEntry = {
    id: newId("callog"), at: new Date().toISOString(), kind: "click_to_call", fromMasked: mask(staffPhone), toMasked: mask(patientPhone),
    status: result.ok ? "connecting" : "failed", detail: result.ok ? `Booking ${bookingRef ?? "—"}` : result.error ?? "Call failed",
    providerId: (result.data as { Call?: { Sid: string } })?.Call?.Sid
  };
  await getStore().docPut(CALLS, entry);
  return { ok: result.ok, entry, error: result.error };
}

/** IVR: the provider sends the caller's key press; we answer with where to route the call. */
export async function handleIvr(from: string, digits: string) {
  const { ivr } = await getCommsSettings();
  const option = ivr.options.find(o => o.digit === digits.trim());
  const entry: CallLogEntry = {
    id: newId("callog"), at: new Date().toISOString(), kind: "ivr", fromMasked: mask(from), toMasked: option?.target ?? "—",
    status: option ? "routed" : "repeat_menu", detail: option ? `Pressed ${digits}: ${option.label} → ${option.target}` : `Pressed "${digits}": not a menu option, greeting repeated`
  };
  await getStore().docPut(CALLS, entry);
  return option ? { action: "route", target: option.target, say: `Connecting you to ${option.label}.` } : { action: "repeat", say: ivr.greeting };
}

export const listMessages = async () => (await getStore().docList<Message>(MESSAGES)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 300).map(viewMessage);
export const listCallLogs = async () => (await getStore().docList<CallLogEntry>(CALLS)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200);
export const MESSAGES_COLLECTION = MESSAGES;
