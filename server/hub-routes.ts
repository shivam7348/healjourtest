// Routes for the Integration Hub: payments, communication, leads, App Store, reliability and compliance.
// /api/hub/* is admin-only (global guard in app.ts). Webhooks, the App Store OAuth/app API and cron
// are open paths that authenticate themselves (signature, URL token, bearer token or CRON_SECRET).

import { publicBaseUrl } from "./core/public-url.js";
import type express from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getStore } from "./core/store.js";
import { hubConnectorModes } from "./core/hub/connectors.js";
import { encryptionStatus } from "./core/compliance/crypto.js";
import { sandboxAppInbox, sandboxChatLog } from "./core/framework/sandbox-partners.js";
import { listAlerts, RUNBOOKS, setAlertStatus } from "./core/hub/alerts.js";
import { createPaymentLink, handlePaymentWebhook, listPayments, listReconRuns, reconcile, refundPayment, simulatePayment, type Payment } from "./core/hub/payments.js";
import { addToCalendar, appointmentIcs, clickToCall, commsToken, getCommsSettings, handleDeliveryReport, handleIvr, listCallLogs, listMessages, queueMessage, saveCommsSettings, DEFAULT_TEMPLATES, type Message } from "./core/hub/comms.js";
import { attribution, ingestLeads, leadsToken, listLeads, SAMPLE_PAYLOADS, SOURCES, updateLead, verifySource, type LeadSource } from "./core/hub/leads.js";
import { authorizeAppCall, createApp, installApp, listApps, listInstallations, reviewApp, REVIEW_CHECKS, revokeInstallation, SANDBOX_CASES, SANDBOX_LAB, SCOPES, sendAppEvent, setAppSuspended, submitApp, tokenGrant, urlProblem } from "./core/hub/appstore.js";
import { listJobRuns, runDaily, runDispatch } from "./core/hub/jobs.js";
import { consentRecords, eraseByPhone, findByPhone, getRetention, listDataRequests, logAccessRequest, runRetention, saveRetention } from "./core/hub/compliance.js";

type Req = express.Request & { rawBody?: string };
const zerr = (e: z.ZodError) => e.issues.map(i => `${i.path.join(".") || "body"}: ${i.message}`).join(" ");
const base = () => publicBaseUrl() || "https://YOUR-DOMAIN";
const who = (req: express.Request) => req.portalUser?.email ?? "admin";
const sameToken = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

export function registerHubRoutes(app: express.Express) {
  // ---------------- overview ----------------
  app.get("/api/hub/overview", async (_req, res) => {
    const store = getStore();
    const [payments, leads, messages, alerts] = await Promise.all([store.docList("payments"), store.docList("leads"), store.docList("messages"), listAlerts()]);
    res.json({
      modes: hubConnectorModes(), encryption: encryptionStatus(),
      counts: { payments: payments.length, leads: leads.length, messages: messages.length, openAlerts: alerts.filter(a => a.status !== "resolved").length },
      cronConfigured: Boolean(process.env.CRON_SECRET?.trim())
    });
  });

  // ---------------- payments ----------------
  app.get("/api/hub/payments", async (_req, res) => {
    res.json({ payments: await listPayments(), recon: await listReconRuns(), modes: hubConnectorModes(), webhookUrl: `${base()}/api/webhooks/payments/razorpay` });
  });
  app.post("/api/hub/payments", async (req, res) => {
    const p = z.object({
      provider: z.enum(["razorpay", "hdfc"]), bookingRef: z.string().trim().min(2).max(60), patientName: z.string().trim().min(2).max(80),
      phone: z.string().trim().regex(/^\+?[\d\s-]{10,15}$/), email: z.string().trim().email().optional().or(z.literal("")),
      amount: z.number().min(1).max(500000), purpose: z.string().trim().min(2).max(120)
    }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    const out = await createPaymentLink({ ...p.data, email: p.data.email || undefined, amountRupees: p.data.amount });
    res.status(out.ok ? 200 : 502).json(out);
  });
  app.post("/api/hub/payments/:id/simulate", async (req, res) => {
    const p = z.object({ outcome: z.enum(["paid", "failed"]), settleAdjust: z.number().min(-100000).max(100000).optional() }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    const out = await simulatePayment(req.params.id, p.data.outcome, p.data.settleAdjust ?? 0);
    res.status(out.ok ? 200 : 400).json(out);
  });
  app.post("/api/hub/payments/:id/refund", async (req, res) => {
    const p = z.object({ amount: z.number().positive().optional(), reason: z.string().trim().min(3).max(200) }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    const out = await refundPayment(req.params.id, p.data.amount, p.data.reason);
    res.status(out.ok ? 200 : 400).json(out);
  });
  app.post("/api/hub/payments/reconcile", async (req, res) => {
    const provider = req.body?.provider === "hdfc" ? "hdfc" : "razorpay";
    res.json(await reconcile(provider, `manual by ${who(req)}`));
  });
  // Gateway webhook (Razorpay format). Signature over the raw body; event ID makes repeats harmless.
  app.post("/api/webhooks/payments/:provider", async (req: Req, res) => {
    const provider = req.params.provider === "hdfc" ? "hdfc" : req.params.provider === "razorpay" ? "razorpay" : null;
    if (!provider) return res.status(404).json({ error: "Unknown provider." });
    const out = await handlePaymentWebhook(provider, req.rawBody ?? "", String(req.headers["x-razorpay-signature"] ?? req.headers["x-signature"] ?? ""), String(req.headers["x-razorpay-event-id"] ?? ""));
    res.status(out.status).json({ outcome: out.outcome });
  });

  // ---------------- communication ----------------
  app.get("/api/hub/comms", async (_req, res) => {
    const settings = await getCommsSettings();
    const appointments = (await getStore().listAppointments()).filter(a => a.status !== "cancelled").sort((a, b) => (b.scheduledAt ?? b.createdAt).localeCompare(a.scheduledAt ?? a.createdAt)).slice(0, 50)
      .map(a => ({ id: a.id, bookingId: a.integratorID, patientName: a.patientName, scheduledAt: a.scheduledAt, status: a.status }));
    res.json({
      messages: await listMessages(), calls: await listCallLogs(), settings, appointments, modes: hubConnectorModes(),
      callbackUrls: { sms: `${base()}/api/webhooks/comms/exotel/${commsToken()}`, ivr: `${base()}/api/webhooks/comms/ivr/${commsToken()}` }
    });
  });
  app.put("/api/hub/comms/settings", async (req, res) => {
    const tpl = z.object({ subject: z.string().trim().min(2).max(150), text: z.string().trim().min(5).max(600) });
    const p = z.object({
      templates: z.object({ booking_confirmation: tpl, reminder: tpl, report_ready: tpl }).optional(),
      ivr: z.object({ greeting: z.string().trim().min(5).max(400), options: z.array(z.object({ digit: z.string().regex(/^[0-9*#]$/), label: z.string().trim().min(2).max(60), target: z.string().trim().min(2).max(60) })).min(1).max(9) }).optional()
    }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    res.json(await saveCommsSettings(p.data as { templates?: typeof DEFAULT_TEMPLATES }));
  });
  app.post("/api/hub/comms/send", async (req, res) => {
    const p = z.object({
      channel: z.enum(["sms", "email"]), to: z.string().trim().min(5).max(120), template: z.enum(["booking_confirmation", "reminder", "report_ready"]),
      vars: z.record(z.string().max(300)).optional(), fallbackEmail: z.string().trim().email().optional().or(z.literal("")), bookingRef: z.string().max(60).optional()
    }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    const m = await queueMessage({ ...p.data, fallbackEmail: p.data.fallbackEmail || undefined, sendNow: true });
    res.json({ ok: m?.status !== "failed", message: m });
  });
  app.post("/api/hub/comms/messages/:id/simulate-delivery", async (req, res) => {
    const m = await getStore().docGet<Message>("messages", req.params.id);
    if (!m?.providerId) return res.status(400).json({ error: "Only a sent message has a delivery report." });
    const status = req.body?.status === "failed" ? "failed" : "delivered";
    await handleDeliveryReport(m.providerId, status, status === "failed" ? "Handset unreachable" : "");
    res.json({ ok: true });
  });
  app.post("/api/hub/comms/dispatch", async (req, res) => { res.json(await runDispatch(`manual by ${who(req)}`)); });
  app.post("/api/hub/comms/call", async (req, res) => {
    const p = z.object({ staffPhone: z.string().trim().min(10).max(15), patientPhone: z.string().trim().min(10).max(15), bookingRef: z.string().max(60).optional() }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    res.json(await clickToCall(p.data.staffPhone, p.data.patientPhone, p.data.bookingRef));
  });
  app.post("/api/hub/comms/ivr-test", async (req, res) => { res.json(await handleIvr(String(req.body?.from ?? "9999999999"), String(req.body?.digits ?? ""))); });
  app.post("/api/hub/appointments/:id/calendar", async (req, res) => {
    const a = (await getStore().listAppointments()).find(x => x.id === req.params.id);
    if (!a) return res.status(404).json({ error: "Booking not found." });
    res.json(await addToCalendar(a));
  });
  app.get("/api/hub/appointments/:id/ics", async (req, res) => {
    const a = (await getStore().listAppointments()).find(x => x.id === req.params.id);
    if (!a) return res.status(404).send("Booking not found.");
    res.setHeader("Content-Disposition", `attachment; filename="booking-${a.integratorID}.ics"`);
    res.type("text/calendar").send(appointmentIcs(a));
  });
  // Exotel status callback (form fields SmsSid, Status, DetailedStatus). Exotel does not sign, so the URL carries a token.
  app.post("/api/webhooks/comms/exotel/:token", async (req, res) => {
    if (!sameToken(req.params.token, commsToken())) return res.status(404).end();
    const b = req.body ?? {};
    await handleDeliveryReport(String(b.SmsSid ?? b.sid ?? ""), String(b.Status ?? b.status ?? ""), String(b.DetailedStatus ?? ""));
    res.status(200).json({ ok: true });
  });
  app.post("/api/webhooks/comms/ivr/:token", async (req, res) => {
    if (!sameToken(req.params.token, commsToken())) return res.status(404).end();
    res.json(await handleIvr(String(req.body?.From ?? ""), String(req.body?.digits ?? req.body?.Digits ?? "")));
  });

  // ---------------- leads ----------------
  const paidByBooking = async () => {
    const map = new Map<string, number>();
    for (const p of await getStore().docList<Payment>("payments")) if (p.status !== "created" && p.status !== "failed") map.set(p.bookingRef, (map.get(p.bookingRef) ?? 0) + (p.amount - p.refunded) / 100);
    return map;
  };
  app.get("/api/hub/leads", async (_req, res) => {
    res.json({
      leads: await listLeads(), attribution: await attribution(await paidByBooking()), sources: SOURCES, samples: SAMPLE_PAYLOADS, modes: hubConnectorModes(),
      webhookUrls: Object.fromEntries(SOURCES.map(s => [s, `${base()}/api/webhooks/leads/${s}/${leadsToken()}`]))
    });
  });
  app.post("/api/hub/leads/simulate", async (req, res) => {
    const source = String(req.body?.source) as LeadSource;
    if (!SOURCES.includes(source)) return res.status(400).json({ error: "Unknown source." });
    const sample = JSON.parse(JSON.stringify(SAMPLE_PAYLOADS[source]));
    // A fresh ID and phone each time so it is a new lead (send the same phone twice to see de-duplication).
    if (req.body?.repeat !== true) {
      const n = String(Date.now()).slice(-6);
      if (source === "meta") sample.entry[0].changes[0].value.leadgen_id = n;
      if (source === "google") { sample.lead_id = `GL-${n}`; sample.user_column_data[1].string_value = `+91 9820${n}`; }
      if (source === "justdial") { sample.leadid = `JD-${n}`; sample.mobile = `9845${n}`; }
      if (source === "practo") { sample.enquiry_id = `PR-${n}`; sample.patient.mobile = `99887${n.slice(-5)}`; }
      if (source === "website") sample.phone = `9123${n}`;
    }
    const problem = verifySource(source, JSON.stringify(sample), sample, "");
    if (problem) return res.status(401).json({ error: problem });
    res.json(await ingestLeads(source, sample));
  });
  app.patch("/api/hub/leads/:id", async (req, res) => {
    const p = z.object({ status: z.enum(["new", "contacted", "booked", "lost"]).optional(), bookingRef: z.string().trim().min(2).max(60).optional() }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    const lead = await updateLead(req.params.id, p.data);
    if (!lead) return res.status(404).json({ error: "Lead not found." });
    res.json({ lead });
  });
  // Meta webhook verification handshake.
  app.get("/api/webhooks/leads/meta/:token", (req, res) => {
    if (!sameToken(req.params.token, leadsToken()) || req.query["hub.mode"] !== "subscribe" || req.query["hub.verify_token"] !== leadsToken()) return res.status(403).end();
    res.type("text/plain").send(String(req.query["hub.challenge"] ?? ""));
  });
  app.post("/api/webhooks/leads/:source/:token", async (req: Req, res) => {
    const source = String(req.params.source) as LeadSource;
    if (!SOURCES.includes(source) || !sameToken(String(req.params.token), leadsToken())) return res.status(404).end();
    const problem = verifySource(source, req.rawBody ?? "", req.body, String(req.headers["x-hub-signature-256"] ?? ""));
    if (problem) return res.status(401).json({ error: problem });
    const out = await ingestLeads(source, req.body);
    res.status(200).json({ received: out.saved.length, errors: out.errors });
  });

  // ---------------- App Store ----------------
  app.get("/api/hub/apps", async (_req, res) => {
    const labs = await getStore().docList<{ id: string; name: string }>("portalLabs");
    res.json({
      apps: await listApps(), installations: await listInstallations(), scopes: SCOPES, checks: REVIEW_CHECKS, inbox: sandboxAppInbox(),
      labs: [SANDBOX_LAB, ...labs.map(l => ({ id: l.id, name: l.name }))],
      endpoints: { token: `${base()}/api/appstore/oauth/token`, cases: `${base()}/api/apps/v1/cases`, results: `${base()}/api/apps/v1/cases/{caseNo}/results` }
    });
  });
  app.post("/api/hub/apps", async (req, res) => {
    const p = z.object({
      name: z.string().trim().min(3).max(60), developer: z.string().trim().min(2).max(80), developerEmail: z.string().trim().email(),
      category: z.string().trim().min(2).max(40), description: z.string().trim().min(10).max(600),
      privacyPolicyUrl: z.string().trim().max(300), redirectUri: z.string().trim().max(300), webhookUrl: z.string().trim().max(300),
      scopes: z.array(z.string()).min(1).max(10)
    }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    for (const [field, value] of [["Redirect URI", p.data.redirectUri], ["Webhook URL", p.data.webhookUrl]] as Array<[string, string]>) {
      const problem = urlProblem(value);
      if (problem) return res.status(400).json({ error: `${field}: ${problem}` });
    }
    const pp = urlProblem(p.data.privacyPolicyUrl, false);
    if (pp) return res.status(400).json({ error: `Privacy policy URL: ${pp}` });
    res.json(await createApp(p.data));
  });
  app.post("/api/hub/apps/:id/submit", async (req, res) => { const out = await submitApp(req.params.id); res.status(out.ok ? 200 : 400).json(out); });
  app.post("/api/hub/apps/:id/review", async (req, res) => {
    const p = z.object({ decision: z.enum(["approved", "rejected"]), checks: z.record(z.boolean()), notes: z.string().max(1000) }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    const out = await reviewApp(req.params.id, p.data.decision, p.data.checks, p.data.notes, who(req));
    res.status(out.ok ? 200 : 400).json(out);
  });
  app.post("/api/hub/apps/:id/suspend", async (req, res) => {
    const a = await setAppSuspended(req.params.id, req.body?.suspended !== false);
    if (!a) return res.status(404).json({ error: "App not found." });
    res.json({ app: a });
  });
  app.post("/api/hub/apps/:id/install", async (req, res) => {
    const p = z.object({ labId: z.string().min(1), scopes: z.array(z.string()).min(1) }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    const lab = p.data.labId === SANDBOX_LAB.id ? SANDBOX_LAB : await getStore().docGet<{ id: string; name: string }>("portalLabs", p.data.labId);
    if (!lab) return res.status(404).json({ error: "Centre not found." });
    const out = await installApp(req.params.id, lab.id, lab.name, p.data.scopes, who(req));
    res.status(out.ok ? 200 : 400).json(out);
  });
  app.post("/api/hub/installations/:id/revoke", async (req, res) => {
    const inst = await revokeInstallation(req.params.id);
    if (!inst) return res.status(404).json({ error: "Installation not found." });
    res.json({ installation: inst });
  });
  app.post("/api/hub/installations/:id/test-event", async (req, res) => {
    res.json(await sendAppEvent(req.params.id, "case.updated", { caseNo: "SBX-1001", status: "report_ready", note: "Test event from Healjour" }));
  });
  // OAuth 2.0 token endpoint for apps (JSON or form body).
  app.post("/api/appstore/oauth/token", async (req, res) => {
    const out = await tokenGrant(Object.fromEntries(Object.entries(req.body ?? {}).map(([k, v]) => [k, String(v)])));
    res.status(out.status).json(out.body);
  });
  // The scoped app API: only the installing centre's data, only with the granted scope.
  app.get("/api/apps/v1/cases", async (req, res) => {
    const auth = await authorizeAppCall(req.headers.authorization, "cases:read");
    if (!auth.inst) return res.status(auth.status ?? 401).json({ error: auth.error });
    if (auth.inst.labId === SANDBOX_LAB.id) return res.json({ lab: SANDBOX_LAB.name, sandbox: true, cases: SANDBOX_CASES.map(({ results: _r, ...c }) => c) });
    const cases = await getStore().docList<any>("labCases", { labId: auth.inst.labId });
    res.json({
      lab: auth.inst.labName, sandbox: false,
      cases: cases.map(c => ({
        caseNo: c.caseNo, status: c.status, tests: (c.tests ?? []).map((t: any) => t.code), createdAt: c.createdAt,
        patient: { initials: String(c.patient?.name ?? "").split(/\s+/).map((w: string) => w[0]).filter(Boolean).join(".") + ".", age: c.patient?.age, gender: c.patient?.gender }
      }))
    });
  });
  app.get("/api/apps/v1/cases/:caseNo/results", async (req, res) => {
    const auth = await authorizeAppCall(req.headers.authorization, "results:read");
    if (!auth.inst) return res.status(auth.status ?? 401).json({ error: auth.error });
    if (auth.inst.labId === SANDBOX_LAB.id) {
      const c = SANDBOX_CASES.find(x => x.caseNo === req.params.caseNo);
      return c ? res.json({ caseNo: c.caseNo, results: c.results }) : res.status(404).json({ error: "Case not found." });
    }
    const c = (await getStore().docList<any>("labCases", { labId: auth.inst.labId, caseNo: req.params.caseNo }))[0];
    if (!c) return res.status(404).json({ error: "Case not found." });
    res.json({ caseNo: c.caseNo, results: (c.results ?? []).map((r: any) => ({ testName: r.testName, value: r.value, unit: r.unit, referenceRange: r.referenceRange, flag: r.flag })) });
  });

  // ---------------- reliability ----------------
  app.get("/api/hub/reliability", async (_req, res) => {
    res.json({ alerts: await listAlerts(), runbooks: RUNBOOKS, jobs: await listJobRuns(), channel: sandboxChatLog(), modes: hubConnectorModes(), cronConfigured: Boolean(process.env.CRON_SECRET?.trim()) });
  });
  app.post("/api/hub/alerts/:id", async (req, res) => {
    const status = req.body?.status === "resolved" ? "resolved" : "acknowledged";
    const a = await setAlertStatus(req.params.id, status, who(req));
    if (!a) return res.status(404).json({ error: "Alert not found." });
    res.json({ alert: a });
  });
  app.post("/api/hub/jobs/daily", async (req, res) => { res.json(await runDaily(`manual by ${who(req)}`)); });
  app.post("/api/hub/jobs/dispatch", async (req, res) => { res.json(await runDispatch(`manual by ${who(req)}`)); });
  // Vercel Cron sends "Authorization: Bearer <CRON_SECRET>".
  const cronOk = (req: express.Request) => {
    const secret = process.env.CRON_SECRET?.trim();
    return Boolean(secret) && sameToken(String(req.headers.authorization ?? ""), `Bearer ${secret}`);
  };
  app.get("/api/cron/daily", async (req, res) => {
    if (!cronOk(req)) return res.status(401).json({ error: "Set CRON_SECRET and send it as a bearer token." });
    res.json(await runDaily("cron"));
  });
  app.get("/api/cron/dispatch", async (req, res) => {
    if (!cronOk(req)) return res.status(401).json({ error: "Set CRON_SECRET and send it as a bearer token." });
    res.json(await runDispatch("cron"));
  });

  // ---------------- compliance ----------------
  app.get("/api/hub/compliance", async (_req, res) => {
    res.json({ encryption: encryptionStatus(), retention: await getRetention(), requests: await listDataRequests(), consentCount: (await consentRecords()).length });
  });
  app.put("/api/hub/compliance/retention", async (req, res) => {
    const p = z.object({ days: z.record(z.number().int().min(1).max(3650)), autoApply: z.boolean() }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    res.json(await saveRetention(p.data.days, p.data.autoApply));
  });
  app.post("/api/hub/compliance/retention/run", async (req, res) => { res.json(await runRetention(req.body?.apply === true)); });
  app.get("/api/hub/compliance/consents", async (req, res) => {
    const rows = await consentRecords();
    if (req.query.format === "csv") {
      const cols = ["healjourId", "purpose", "abdmPurposeCode", "abdmPurpose", "state", "granted", "grantedAt", "expiresAt"] as const;
      res.setHeader("Content-Disposition", `attachment; filename="consent-records-${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.type("text/csv").send("﻿" + [cols.join(","), ...rows.map(r => cols.map(c => csvCell(r[c])).join(","))].join("\n"));
    }
    res.setHeader("Content-Disposition", `attachment; filename="consent-records-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({ exportedAt: new Date().toISOString(), records: rows });
  });
  app.post("/api/hub/compliance/lookup", async (req, res) => {
    const phone = String(req.body?.phone ?? "");
    if (phone.replace(/\D/g, "").length < 10) return res.status(400).json({ error: "Enter a 10-digit mobile number." });
    await logAccessRequest(phone, who(req));
    res.json(await findByPhone(phone));
  });
  app.post("/api/hub/compliance/erase", async (req, res) => {
    const p = z.object({ phone: z.string().min(10).max(15), reason: z.string().trim().min(5).max(300), confirm: z.string() }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    const last4 = p.data.phone.replace(/\D/g, "").slice(-4);
    if (p.data.confirm !== `ERASE ${last4}`) return res.status(400).json({ error: `Type ERASE ${last4} to confirm.` });
    res.json(await eraseByPhone(p.data.phone, who(req), p.data.reason));
  });
}
