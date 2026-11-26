// Healjour Developer Platform routes.
//
//   /api/v1/*          Public API for outside developers (Bearer token). Documented at /developers.
//   /api/developer/*   Developer console: self-serve sign-up, API apps, keys, webhooks, logs (own session cookie).
//   /api/portal/api-keys   Lab admins create "lab" API apps for their own lab (Lab Portal).
//   /api/super/developers  Super Admin oversight: every developer account and API app; disable / revoke.
//
// Data rule: a partner app sees only bookings it created; a lab app sees only its own lab's bookings.

import type express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getStore } from "./core/store.js";
import { recordAudit } from "./core/identity.js";
import { logIntegration } from "./core/logs.js";
import {
  clearLoginFailures, hashPassword, LABS, loginBlocked, passwordProblem, recordLoginFailure, requirePermission, verifyPassword,
  type PortalLab
} from "./core/portal/auth.js";
import { isSuperAdmin } from "./core/portal/access.js";
import {
  ACCESS_TTL_S, API_CLIENTS, clientForAccessToken, createClient, createDevSession, currentDeveloper, DEV_ACCOUNTS, endDevSession,
  logRequest, newId as platformId, publicAccount, publicClient, RATE_LIMIT, recentRequests, revokeClient, rotateSecret,
  takeRateLimit, tokenForCredentials, tokenForRefresh, touchClient, type ApiClient, type DevAccount
} from "./core/devplatform/platform.js";
import {
  addWebhook, emitEvent, isWebhookEvent, listWebhooks, publicWebhook, recentDeliveries, removeWebhook, sendTest, WEBHOOK_EVENTS, WEBHOOKS,
  type Webhook, type WebhookEvent
} from "./core/devplatform/webhooks.js";
import {
  apiBooking, CASE_STATUSES, CASES, caseNo, FINAL, LAB_NEXT, MAX_REPORT_BYTES, newId, recordLabUpdate, REPORT_TYPES, REPORTS, STATUS_WORDS,
  type CaseUpdater, type LabCase, type ReportMeta, type StoredReport
} from "./portal-routes.js";
import { buildOpenApi } from "../src/lib/api-docs.js";

declare module "express-serve-static-core" {
  interface Request { apiClient?: ApiClient; requestId?: string }
}

// ---------- response helpers (one format everywhere) ----------
const ok = (res: express.Response, data: unknown, status = 200) => res.status(status).json({ success: true, data });
const fail = (res: express.Response, status: number, code: string, message: string, details?: unknown) =>
  res.status(status).json({ success: false, error: { code, message, ...(details ? { details } : {}) } });
const zodDetails = (e: z.ZodError) => e.issues.map(i => ({ field: i.path.join(".") || "body", message: i.message }));

const appActor = (c: ApiClient): CaseUpdater => ({ name: `${c.name} (API)`, email: `api:${c.clientId}`, role: "api" });

/** Checks the report bytes really are the file type claimed. */
function reportProblem(mimeType: string, bytes: Buffer) {
  if (!REPORT_TYPES.includes(mimeType)) return "mimeType must be application/pdf, image/png or image/jpeg.";
  if (!bytes.length) return "The file is empty.";
  if (bytes.length > MAX_REPORT_BYTES) return "The file is larger than 3 MB.";
  const pdf = bytes.subarray(0, 4).toString("latin1") === "%PDF";
  const png = bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const match = mimeType === "application/pdf" ? pdf : mimeType === "image/png" ? png : jpg;
  return match ? null : "The file content does not match its mimeType.";
}

export function registerDevPlatformRoutes(app: express.Express) {
  const store = () => getStore();

  // ======================================================================================
  // Public API v1
  // ======================================================================================

  app.get("/api/v1/openapi.json", (_req, res) => res.json(buildOpenApi()));

  app.post("/api/v1/auth/token", async (req, res) => {
    const p = z.object({ clientId: z.string().min(4).max(120), clientSecret: z.string().min(10).max(200) }).safeParse(req.body);
    if (!p.success) return fail(res, 400, "invalid_request", "Send clientId and clientSecret.", zodDetails(p.error));
    const key = `api|${p.data.clientId}|${req.ip}`;
    if (loginBlocked(key)) return fail(res, 429, "too_many_attempts", "Too many wrong attempts. Try again in 15 minutes.");
    const tokens = await tokenForCredentials(p.data.clientId, p.data.clientSecret);
    if (!tokens) { recordLoginFailure(key); return fail(res, 401, "invalid_client", "Client ID or secret is not correct, or the app was revoked."); }
    clearLoginFailures(key);
    ok(res, tokens);
  });

  app.post("/api/v1/auth/refresh", async (req, res) => {
    const p = z.object({ refreshToken: z.string().min(10).max(200) }).safeParse(req.body);
    if (!p.success) return fail(res, 400, "invalid_request", "Send refreshToken.");
    const tokens = await tokenForRefresh(p.data.refreshToken);
    if (!tokens) return fail(res, 401, "invalid_token", "The refresh token is invalid, expired or already used.");
    ok(res, tokens);
  });

  // Everything else under /api/v1 needs a Bearer access token; rate limit and request log per app.
  app.use("/api/v1", async (req, res, next) => {
    if (req.path === "/openapi.json" || req.path.startsWith("/auth/")) return next();
    const requestId = `req_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    req.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    const auth = req.headers.authorization ?? "";
    const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim();
    if (!token) return fail(res, 401, "missing_token", "Send Authorization: Bearer <accessToken>. Get one from POST /api/v1/auth/token.");
    const client = await clientForAccessToken(token);
    if (!client) return fail(res, 401, "invalid_token", "The access token is invalid or expired. Get a new one with your refresh token.");
    const limit = takeRateLimit(client.clientId);
    res.setHeader("X-RateLimit-Limit", String(RATE_LIMIT));
    res.setHeader("X-RateLimit-Remaining", String(limit.remaining));
    if (!limit.allowed) { res.setHeader("Retry-After", String(limit.resetSeconds)); return fail(res, 429, "rate_limited", `Limit is ${RATE_LIMIT} requests per minute per app. Retry after ${limit.resetSeconds} s.`); }
    req.apiClient = client;
    const started = Date.now();
    res.on("finish", () => logRequest(client.clientId, { at: new Date().toISOString(), method: req.method, path: req.originalUrl.split("?")[0], status: res.statusCode, ms: Date.now() - started, requestId }));
    void touchClient(client);
    next();
  });

  const partnerOnly = (req: express.Request, res: express.Response) => {
    if (req.apiClient!.kind !== "partner") { fail(res, 403, "wrong_app_type", "Only partner apps (created on the developer console) can do this."); return false; }
    return true;
  };
  const labOnly = (req: express.Request, res: express.Response) => {
    if (req.apiClient!.kind !== "lab") { fail(res, 403, "wrong_app_type", "Only lab apps (created by a lab admin in the Lab Portal) can do this."); return false; }
    return true;
  };
  /** A booking this app may see, found by id or booking number. */
  const visibleBooking = async (client: ApiClient, idOrNo: string): Promise<LabCase | null> => {
    const c = (await store().docGet<LabCase>(CASES, idOrNo)) ?? (await store().docList<LabCase>(CASES, { caseNo: idOrNo }))[0];
    if (!c) return null;
    if (client.kind === "lab") return c.labId === client.labId ? c : null;
    return c.source?.clientId === client.clientId ? c : null;
  };

  app.get("/api/v1/me", async (req, res) => {
    const c = req.apiClient!;
    const lab = c.labId ? await store().docGet<PortalLab>(LABS, c.labId) : null;
    ok(res, { app: { clientId: c.clientId, name: c.name, kind: c.kind, lab: lab ? { id: lab.id, name: lab.name, code: lab.code } : null }, rateLimitPerMinute: RATE_LIMIT, tokenLifetimeSeconds: ACCESS_TTL_S });
  });

  // ---------- catalog ----------
  app.get("/api/v1/tests", async (req, res) => {
    const q = String(req.query.search ?? "").trim().toLowerCase();
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500), offset = Math.max(Number(req.query.offset) || 0, 0);
    const all = (await store().listCatalogTests()).filter(t => t.active && (!q || `${t.code} ${t.name}`.toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name));
    ok(res, {
      total: all.length, limit, offset,
      tests: all.slice(offset, offset + limit).map(t => ({ code: t.code, name: t.name, price: t.price, sampleType: t.sampleType ?? null, category: t.category ?? null, loinc: t.loinc ?? null }))
    });
  });
  app.get("/api/v1/packages", async (_req, res) => {
    const packages = (await store().listCatalogPackages()).filter(p => p.active);
    ok(res, { total: packages.length, packages: packages.map(p => ({ code: p.code, name: p.name, price: p.price, testCodes: p.testCodes })) });
  });
  app.get("/api/v1/labs", async (req, res) => {
    const c = req.apiClient!;
    const labs = (await store().docList<PortalLab>(LABS)).filter(l => l.active && (c.kind === "partner" || l.id === c.labId));
    ok(res, { labs: labs.sort((a, b) => a.name.localeCompare(b.name)).map(l => ({ id: l.id, code: l.code, name: l.name, city: l.city ?? null })) });
  });

  // ---------- bookings ----------
  const bookingSchema = z.object({
    labId: z.string().min(1).max(80),
    externalId: z.string().trim().min(1).max(80).optional(),
    patient: z.object({
      name: z.string().trim().min(2).max(100), age: z.number().int().min(0).max(150),
      ageUnit: z.enum(["year", "month", "day"]).default("year"), gender: z.enum(["male", "female", "other"]),
      phone: z.string().trim().regex(/^\d{10}$/, "phone must be 10 digits").optional(),
      healjourId: z.string().trim().max(60).optional()
    }),
    tests: z.array(z.string().trim().min(1).max(30)).min(1, "Add at least one test code.").max(100),
    priority: z.enum(["routine", "urgent", "stat"]).default("routine"),
    collection: z.enum(["home", "lab_visit"]).default("lab_visit"),
    scheduledAt: z.string().datetime({ offset: true }).optional(),
    notes: z.string().trim().max(1000).optional()
  });

  app.post("/api/v1/bookings", async (req, res) => {
    if (!partnerOnly(req, res)) return;
    const client = req.apiClient!;
    const p = bookingSchema.safeParse(req.body);
    if (!p.success) return fail(res, 400, "validation_failed", "Some fields are missing or wrong.", zodDetails(p.error));
    if (p.data.externalId) {
      // Idempotent: sending the same externalId again returns the booking made the first time.
      const same = (await store().docList<LabCase>(CASES, { "source.clientId": client.clientId, "source.externalId": p.data.externalId }))[0];
      if (same) return ok(res, { booking: apiBooking(same), duplicate: true });
    }
    const lab = await store().docGet<PortalLab>(LABS, p.data.labId);
    if (!lab || !lab.active) return fail(res, 404, "lab_not_found", "No active lab with this labId. List labs with GET /api/v1/labs.");
    const catalog = new Map((await store().listCatalogTests()).filter(t => t.active).map(t => [t.code.toUpperCase(), t]));
    const unknown = p.data.tests.filter(code => !catalog.has(code.toUpperCase()));
    if (unknown.length) return fail(res, 400, "unknown_tests", `Unknown test code(s): ${unknown.join(", ")}. List tests with GET /api/v1/tests.`, { unknown });
    const now = new Date().toISOString();
    const c: LabCase = {
      id: newId("case"), caseNo: caseNo(), labId: lab.id, labName: lab.name,
      patient: p.data.patient, tests: p.data.tests.map(code => { const t = catalog.get(code.toUpperCase())!; return { code: t.code, name: t.name }; }),
      priority: p.data.priority, collection: p.data.collection, scheduledAt: p.data.scheduledAt, notes: p.data.notes,
      status: "new", results: [], reports: [],
      timeline: [{ at: now, by: `${client.name} (API)`, role: "api", action: "Booking received via API", status: "new" }],
      createdAt: now, createdBy: client.clientId, updatedAt: now,
      creator: { id: client.clientId, name: `${client.name} (API app)`, email: client.createdBy.email },
      source: { clientId: client.clientId, appName: client.name, ...(p.data.externalId ? { externalId: p.data.externalId } : {}) }
    };
    await store().docPut(CASES, c);
    await logIntegration({ type: "lab_portal", status: "success", account: lab.name, title: `API booking ${c.caseNo} from ${client.name}`, message: `${c.patient.name}, ${c.tests.length} test(s), ${c.priority}.`, integratorID: c.caseNo });
    await recordAudit({ actor: `api:${client.clientId}`, action: "api.booking.create", detail: `${c.caseNo} to ${lab.code} by app ${client.name}` });
    void emitEvent("booking.created", { booking: apiBooking(c) }, { clientIds: [client.clientId], labId: lab.id });
    ok(res, { booking: apiBooking(c), duplicate: false }, 201);
  });

  app.get("/api/v1/bookings", async (req, res) => {
    const client = req.apiClient!;
    const status = String(req.query.status ?? "");
    if (status && !(CASE_STATUSES as readonly string[]).includes(status)) return fail(res, 400, "invalid_status", `status must be one of: ${CASE_STATUSES.join(", ")}.`);
    const since = String(req.query.updatedSince ?? "");
    if (since && Number.isNaN(Date.parse(since))) return fail(res, 400, "invalid_date", "updatedSince must be an ISO date-time.");
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200), offset = Math.max(Number(req.query.offset) || 0, 0);
    const where: Record<string, unknown> = client.kind === "lab" ? { labId: client.labId } : { "source.clientId": client.clientId };
    if (status) where.status = status;
    const all = (await store().docList<LabCase>(CASES, where)).filter(c => !since || c.updatedAt > new Date(since).toISOString())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    ok(res, { total: all.length, limit, offset, bookings: all.slice(offset, offset + limit).map(apiBooking) });
  });

  app.get("/api/v1/bookings/:id", async (req, res) => {
    const c = await visibleBooking(req.apiClient!, req.params.id);
    if (!c) return fail(res, 404, "booking_not_found", "No booking with this id that your app can see.");
    ok(res, { booking: apiBooking(c) });
  });

  app.post("/api/v1/bookings/:id/cancel", async (req, res) => {
    if (!partnerOnly(req, res)) return;
    const p = z.object({ reason: z.string().trim().min(3).max(500) }).safeParse(req.body);
    if (!p.success) return fail(res, 400, "validation_failed", "Give a reason (3-500 characters).");
    const c = await visibleBooking(req.apiClient!, req.params.id);
    if (!c) return fail(res, 404, "booking_not_found", "No booking with this id that your app can see.");
    if (!["new", "accepted"].includes(c.status)) return fail(res, 409, "cannot_cancel", `A booking that is "${STATUS_WORDS[c.status]}" can no longer be cancelled.`);
    c.status = "cancelled";
    await recordLabUpdate(c, appActor(req.apiClient!), `${STATUS_WORDS.new} → ${STATUS_WORDS.cancelled}`, { status: "cancelled", note: p.data.reason });
    ok(res, { booking: apiBooking(c) });
  });

  app.post("/api/v1/bookings/:id/status", async (req, res) => {
    if (!labOnly(req, res)) return;
    const p = z.object({ status: z.enum(CASE_STATUSES), note: z.string().trim().max(500).optional() }).safeParse(req.body);
    if (!p.success) return fail(res, 400, "validation_failed", `status must be one of: ${CASE_STATUSES.join(", ")}.`, zodDetails(p.error));
    const c = await visibleBooking(req.apiClient!, req.params.id);
    if (!c) return fail(res, 404, "booking_not_found", "No booking with this id for your lab.");
    const to = p.data.status;
    if (!LAB_NEXT[c.status].includes(to)) return fail(res, 409, "invalid_transition", `"${STATUS_WORDS[c.status]}" cannot move to "${STATUS_WORDS[to]}". Allowed next: ${LAB_NEXT[c.status].join(", ") || "none"}.`, { from: c.status, allowed: LAB_NEXT[c.status] });
    if (to === "rejected" && !p.data.note) return fail(res, 400, "note_required", "Give a note when rejecting.");
    if (to === "report_ready" && !c.reports.length) return fail(res, 409, "report_required", "Upload the report first (POST /api/v1/bookings/{id}/reports).");
    const from = c.status;
    c.status = to;
    await recordLabUpdate(c, appActor(req.apiClient!), `${STATUS_WORDS[from]} → ${STATUS_WORDS[to]}`, { status: to, note: p.data.note });
    ok(res, { booking: apiBooking(c) });
  });

  app.put("/api/v1/bookings/:id/results", async (req, res) => {
    if (!labOnly(req, res)) return;
    const p = z.object({
      results: z.array(z.object({
        testCode: z.string().min(1).max(30), testName: z.string().max(120).default(""), value: z.string().trim().max(60),
        unit: z.string().trim().max(30).default(""), referenceRange: z.string().trim().max(60).default(""),
        flag: z.enum(["", "normal", "low", "high", "abnormal"]).default("")
      })).max(200)
    }).safeParse(req.body);
    if (!p.success) return fail(res, 400, "validation_failed", "results must be a list of { testCode, value, unit, referenceRange, flag }.", zodDetails(p.error));
    const c = await visibleBooking(req.apiClient!, req.params.id);
    if (!c) return fail(res, 404, "booking_not_found", "No booking with this id for your lab.");
    if (FINAL.includes(c.status)) return fail(res, 409, "booking_closed", "This booking is closed.");
    c.results = p.data.results.filter(r => r.value !== "");
    await recordLabUpdate(c, appActor(req.apiClient!), `Results entered (${c.results.length})`, {}, "booking.results_updated");
    ok(res, { booking: apiBooking(c) });
  });

  app.post("/api/v1/bookings/:id/reports", async (req, res) => {
    if (!labOnly(req, res)) return;
    const p = z.object({ fileName: z.string().trim().min(1).max(160), mimeType: z.string(), dataBase64: z.string().min(1), note: z.string().trim().max(300).optional() }).safeParse(req.body);
    if (!p.success) return fail(res, 400, "validation_failed", "Send fileName, mimeType and dataBase64.", zodDetails(p.error));
    const c = await visibleBooking(req.apiClient!, req.params.id);
    if (!c) return fail(res, 404, "booking_not_found", "No booking with this id for your lab.");
    if (FINAL.includes(c.status)) return fail(res, 409, "booking_closed", "This booking is closed.");
    const bytes = Buffer.from(p.data.dataBase64, "base64");
    const problem = reportProblem(p.data.mimeType, bytes);
    if (problem) return fail(res, 400, "invalid_file", problem);
    const client = req.apiClient!;
    const meta: ReportMeta = { id: newId("rpt"), fileName: p.data.fileName.replace(/[^\w.\- ()]+/g, "_"), mimeType: p.data.mimeType, size: bytes.length, uploadedAt: new Date().toISOString(), uploadedBy: `${client.name} (API)`, note: p.data.note || undefined };
    await store().docPut<StoredReport>(REPORTS, { id: meta.id, caseId: c.id, labId: c.labId, fileName: meta.fileName, mimeType: meta.mimeType, size: meta.size, dataBase64: bytes.toString("base64"), uploadedAt: meta.uploadedAt });
    c.reports.push(meta);
    await recordLabUpdate(c, appActor(client), `Report uploaded: ${meta.fileName}`, { note: meta.note }, "booking.report_uploaded");
    ok(res, { report: { id: meta.id, fileName: meta.fileName, mimeType: meta.mimeType, size: meta.size, uploadedAt: meta.uploadedAt }, booking: apiBooking(c) }, 201);
  });

  app.get("/api/v1/bookings/:id/reports/:reportId", async (req, res) => {
    const c = await visibleBooking(req.apiClient!, req.params.id);
    if (!c) return fail(res, 404, "booking_not_found", "No booking with this id that your app can see.");
    const r = await store().docGet<StoredReport>(REPORTS, req.params.reportId);
    if (!r || r.caseId !== c.id) return fail(res, 404, "report_not_found", "No report with this id on this booking.");
    const data = Buffer.from(r.dataBase64, "base64");
    res.setHeader("Content-Type", r.mimeType);
    res.setHeader("Content-Length", String(data.length));
    res.setHeader("Content-Disposition", `attachment; filename="${r.fileName.replace(/"/g, "")}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.end(data);
  });

  // ---------- webhooks (an app manages its own) ----------
  const webhookBody = z.object({ url: z.string().trim().url().max(500), events: z.array(z.string()).min(1).max(Object.keys(WEBHOOK_EVENTS).length) });
  const createWebhookFor = async (client: ApiClient, body: unknown, res: express.Response) => {
    const p = webhookBody.safeParse(body);
    if (!p.success) return fail(res, 400, "validation_failed", "Send url (https) and events.", zodDetails(p.error));
    const bad = p.data.events.filter(e => !isWebhookEvent(e));
    if (bad.length) return fail(res, 400, "unknown_events", `Unknown event(s): ${bad.join(", ")}.`, { allowed: Object.keys(WEBHOOK_EVENTS) });
    const out = await addWebhook(client.clientId, p.data.url, p.data.events as WebhookEvent[]);
    if (!out.ok) return fail(res, 400, "invalid_url", out.error);
    // The signing secret is returned only now; store it to verify X-Healjour-Signature.
    ok(res, { webhook: { ...publicWebhook(out.webhook), secret: out.webhook.secret } }, 201);
  };
  app.get("/api/v1/webhooks/events", (_req, res) => ok(res, { events: Object.entries(WEBHOOK_EVENTS).map(([name, description]) => ({ name, description })) }));
  app.get("/api/v1/webhooks", async (req, res) => ok(res, { webhooks: (await listWebhooks(req.apiClient!.clientId)).map(publicWebhook) }));
  app.post("/api/v1/webhooks", async (req, res) => createWebhookFor(req.apiClient!, req.body, res));
  app.delete("/api/v1/webhooks/:id", async (req, res) => {
    if (!(await removeWebhook(req.apiClient!.clientId, req.params.id))) return fail(res, 404, "webhook_not_found", "No webhook with this id on your app.");
    ok(res, { deleted: true });
  });

  // Unknown /api/v1 paths answer in the same JSON shape.
  app.all("/api/v1/*", (_req, res) => fail(res, 404, "not_found", "No such endpoint. See /developers for the API reference."));

  // ======================================================================================
  // Developer console
  // ======================================================================================

  const needDev = async (req: express.Request, res: express.Response) => {
    const dev = await currentDeveloper(req);
    if (!dev) { fail(res, 401, "not_signed_in", "Please sign in to the developer console."); return null; }
    return dev;
  };
  const ownApp = async (dev: DevAccount, id: string) => {
    const c = await store().docGet<ApiClient>(API_CLIENTS, id);
    return c && c.ownerType === "developer" && c.ownerId === dev.id ? c : null;
  };

  app.post("/api/developer/signup", async (req, res) => {
    const p = z.object({
      name: z.string().trim().min(2).max(80), email: z.string().trim().toLowerCase().email(),
      company: z.string().trim().min(2).max(120), password: z.string().max(200)
    }).safeParse(req.body);
    if (!p.success) return fail(res, 400, "validation_failed", "Enter your name, work email, company and a password.", zodDetails(p.error));
    const problem = passwordProblem(p.data.password);
    if (problem) return fail(res, 400, "weak_password", problem);
    if ((await store().docList<DevAccount>(DEV_ACCOUNTS, { email: p.data.email })).length) return fail(res, 409, "email_taken", "An account with this email exists. Sign in instead.");
    const account: DevAccount = { id: platformId("dev"), name: p.data.name, email: p.data.email, company: p.data.company, passwordHash: hashPassword(p.data.password), active: true, createdAt: new Date().toISOString(), lastLoginAt: new Date().toISOString() };
    await store().docPut(DEV_ACCOUNTS, account);
    await recordAudit({ actor: `developer:${account.email}`, action: "developer.signup", detail: `${account.name} (${account.company})` });
    await createDevSession(req, res, account);
    ok(res, { account: publicAccount(account) }, 201);
  });

  app.post("/api/developer/login", async (req, res) => {
    const p = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().max(200) }).safeParse(req.body);
    if (!p.success) return fail(res, 400, "validation_failed", "Enter your email and password.");
    const key = `dev|${p.data.email}|${req.ip}`;
    if (loginBlocked(key)) return fail(res, 429, "too_many_attempts", "Too many wrong attempts. Try again in 15 minutes.");
    const account = (await store().docList<DevAccount>(DEV_ACCOUNTS, { email: p.data.email }))[0];
    if (!account || !verifyPassword(p.data.password, account.passwordHash)) { recordLoginFailure(key); return fail(res, 401, "wrong_credentials", "Email or password is not correct."); }
    if (!account.active) return fail(res, 403, "account_disabled", "This developer account is disabled. Contact Healjour.");
    clearLoginFailures(key);
    await store().docPut(DEV_ACCOUNTS, { ...account, lastLoginAt: new Date().toISOString() });
    await createDevSession(req, res, account);
    ok(res, { account: publicAccount(account) });
  });

  app.post("/api/developer/logout", async (req, res) => { await endDevSession(req, res); ok(res, { signedOut: true }); });

  app.get("/api/developer/me", async (req, res) => {
    const dev = await currentDeveloper(req);
    res.setHeader("Cache-Control", "private, no-store");
    ok(res, { account: dev ? publicAccount(dev) : null });
  });

  app.get("/api/developer/apps", async (req, res) => {
    const dev = await needDev(req, res); if (!dev) return;
    const apps = (await store().docList<ApiClient>(API_CLIENTS, { ownerType: "developer", ownerId: dev.id })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    ok(res, { apps: await Promise.all(apps.map(async a => ({ ...publicClient(a), webhooks: (await listWebhooks(a.clientId)).length }))) });
  });

  app.post("/api/developer/apps", async (req, res) => {
    const dev = await needDev(req, res); if (!dev) return;
    const p = z.object({ name: z.string().trim().min(2).max(60), description: z.string().trim().max(300).default("") }).safeParse(req.body);
    if (!p.success) return fail(res, 400, "validation_failed", "Give the app a name (2-60 characters).");
    const mine = (await store().docList<ApiClient>(API_CLIENTS, { ownerType: "developer", ownerId: dev.id })).filter(a => a.active);
    if (mine.length >= 10) return fail(res, 409, "app_limit", "You can have up to 10 active apps. Revoke one first.");
    const { client, secret } = await createClient({ name: p.data.name, description: p.data.description, kind: "partner", ownerType: "developer", ownerId: dev.id, createdBy: { id: dev.id, name: dev.name, email: dev.email } });
    await recordAudit({ actor: `developer:${dev.email}`, action: "developer.app.create", detail: `${client.name} (${client.clientId})` });
    ok(res, { app: publicClient(client), clientSecret: secret }, 201);
  });

  app.post("/api/developer/apps/:id/rotate", async (req, res) => {
    const dev = await needDev(req, res); if (!dev) return;
    const c = await ownApp(dev, req.params.id);
    if (!c || !c.active) return fail(res, 404, "app_not_found", "No active app with this id.");
    const { client, secret } = await rotateSecret(c);
    await recordAudit({ actor: `developer:${dev.email}`, action: "developer.app.rotate", detail: `${client.name} (${client.clientId})` });
    ok(res, { app: publicClient(client), clientSecret: secret });
  });

  app.delete("/api/developer/apps/:id", async (req, res) => {
    const dev = await needDev(req, res); if (!dev) return;
    const c = await ownApp(dev, req.params.id);
    if (!c) return fail(res, 404, "app_not_found", "No app with this id.");
    await revokeClient(c, `developer:${dev.email}`);
    await recordAudit({ actor: `developer:${dev.email}`, action: "developer.app.revoke", detail: `${c.name} (${c.clientId})` });
    ok(res, { revoked: true });
  });

  app.get("/api/developer/apps/:id/activity", async (req, res) => {
    const dev = await needDev(req, res); if (!dev) return;
    const c = await ownApp(dev, req.params.id);
    if (!c) return fail(res, 404, "app_not_found", "No app with this id.");
    ok(res, { requests: recentRequests(c.clientId), deliveries: await recentDeliveries(c.clientId) });
  });

  app.get("/api/developer/apps/:id/webhooks", async (req, res) => {
    const dev = await needDev(req, res); if (!dev) return;
    const c = await ownApp(dev, req.params.id);
    if (!c) return fail(res, 404, "app_not_found", "No app with this id.");
    ok(res, { webhooks: (await listWebhooks(c.clientId)).map(publicWebhook), events: Object.entries(WEBHOOK_EVENTS).map(([name, description]) => ({ name, description })) });
  });
  app.post("/api/developer/apps/:id/webhooks", async (req, res) => {
    const dev = await needDev(req, res); if (!dev) return;
    const c = await ownApp(dev, req.params.id);
    if (!c || !c.active) return fail(res, 404, "app_not_found", "No active app with this id.");
    return createWebhookFor(c, req.body, res);
  });
  app.delete("/api/developer/apps/:id/webhooks/:wid", async (req, res) => {
    const dev = await needDev(req, res); if (!dev) return;
    const c = await ownApp(dev, req.params.id);
    if (!c || !(await removeWebhook(c.clientId, req.params.wid))) return fail(res, 404, "webhook_not_found", "No such webhook.");
    ok(res, { deleted: true });
  });
  app.post("/api/developer/apps/:id/webhooks/:wid/test", async (req, res) => {
    const dev = await needDev(req, res); if (!dev) return;
    const c = await ownApp(dev, req.params.id);
    const hook = c ? await store().docGet<Webhook>(WEBHOOKS, req.params.wid) : undefined;
    if (!c || !hook || hook.clientId !== c.clientId) return fail(res, 404, "webhook_not_found", "No such webhook.");
    ok(res, { delivery: await sendTest(hook) });
  });

  // ======================================================================================
  // Lab Portal: lab admins create API apps for their own lab
  // ======================================================================================

  const labApp = async (req: express.Request, id: string) => {
    const c = await store().docGet<ApiClient>(API_CLIENTS, id);
    return c && c.kind === "lab" && c.labId === req.portalUser!.labId ? c : null;
  };
  app.get("/api/portal/api-keys", requirePermission("team:manage"), async (req, res) => {
    const user = req.portalUser!;
    if (user.role !== "lab_admin") return fail(res, 403, "lab_admin_only", "Only a lab admin manages the lab's API apps.");
    const apps = (await store().docList<ApiClient>(API_CLIENTS, { kind: "lab", labId: user.labId })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    ok(res, { apps: await Promise.all(apps.map(async a => ({ ...publicClient(a), webhooks: (await listWebhooks(a.clientId)).map(publicWebhook) }))), events: Object.entries(WEBHOOK_EVENTS).map(([name, description]) => ({ name, description })) });
  });
  app.post("/api/portal/api-keys", requirePermission("team:manage"), async (req, res) => {
    const user = req.portalUser!;
    if (user.role !== "lab_admin" || !user.labId) return fail(res, 403, "lab_admin_only", "Only a lab admin creates the lab's API apps.");
    const p = z.object({ name: z.string().trim().min(2).max(60) }).safeParse(req.body);
    if (!p.success) return fail(res, 400, "validation_failed", "Give the app a name (e.g. \"Our LIS\").");
    const mine = (await store().docList<ApiClient>(API_CLIENTS, { kind: "lab", labId: user.labId })).filter(a => a.active);
    if (mine.length >= 5) return fail(res, 409, "app_limit", "A lab can have up to 5 active API apps.");
    const { client, secret } = await createClient({ name: p.data.name, description: "", kind: "lab", ownerType: "lab", ownerId: user.labId, labId: user.labId, createdBy: { id: user.id, name: user.name, email: user.email } });
    await recordAudit({ actor: `${user.role}:${user.email}`, action: "lab.api_app.create", detail: `${client.name} (${client.clientId})` });
    ok(res, { app: publicClient(client), clientSecret: secret }, 201);
  });
  app.post("/api/portal/api-keys/:id/rotate", requirePermission("team:manage"), async (req, res) => {
    const c = req.portalUser!.role === "lab_admin" ? await labApp(req, String(req.params.id)) : null;
    if (!c || !c.active) return fail(res, 404, "app_not_found", "No active API app with this id.");
    const { client, secret } = await rotateSecret(c);
    await recordAudit({ actor: `${req.portalUser!.role}:${req.portalUser!.email}`, action: "lab.api_app.rotate", detail: client.clientId });
    ok(res, { app: publicClient(client), clientSecret: secret });
  });
  app.delete("/api/portal/api-keys/:id", requirePermission("team:manage"), async (req, res) => {
    const c = req.portalUser!.role === "lab_admin" ? await labApp(req, String(req.params.id)) : null;
    if (!c) return fail(res, 404, "app_not_found", "No API app with this id.");
    await revokeClient(c, `${req.portalUser!.role}:${req.portalUser!.email}`);
    await recordAudit({ actor: `${req.portalUser!.role}:${req.portalUser!.email}`, action: "lab.api_app.revoke", detail: c.clientId });
    ok(res, { revoked: true });
  });
  app.post("/api/portal/api-keys/:id/webhooks", requirePermission("team:manage"), async (req, res) => {
    const c = req.portalUser!.role === "lab_admin" ? await labApp(req, String(req.params.id)) : null;
    if (!c || !c.active) return fail(res, 404, "app_not_found", "No active API app with this id.");
    return createWebhookFor(c, req.body, res);
  });
  app.delete("/api/portal/api-keys/:id/webhooks/:wid", requirePermission("team:manage"), async (req, res) => {
    const c = req.portalUser!.role === "lab_admin" ? await labApp(req, String(req.params.id)) : null;
    if (!c || !(await removeWebhook(c.clientId, String(req.params.wid)))) return fail(res, 404, "webhook_not_found", "No such webhook.");
    ok(res, { deleted: true });
  });

  // ======================================================================================
  // Super Admin oversight (the /api/super guard in app.ts already limits these to Super Admins)
  // ======================================================================================

  app.get("/api/super/developers", async (req, res) => {
    if (!isSuperAdmin(req.portalUser)) return fail(res, 403, "forbidden", "Super Admins only.");
    const [accounts, clients, labs] = await Promise.all([store().docList<DevAccount>(DEV_ACCOUNTS), store().docList<ApiClient>(API_CLIENTS), store().docList<PortalLab>(LABS)]);
    const labName = new Map(labs.map(l => [l.id, l.name]));
    ok(res, {
      accounts: accounts.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(a => ({ ...publicAccount(a), apps: clients.filter(c => c.ownerType === "developer" && c.ownerId === a.id).length })),
      apps: clients.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(c => ({ ...publicClient(c), labName: c.labId ? labName.get(c.labId) ?? c.labId : null, recentRequests: recentRequests(c.clientId).length }))
    });
  });
  app.put("/api/super/developers/:id", async (req, res) => {
    if (!isSuperAdmin(req.portalUser)) return fail(res, 403, "forbidden", "Super Admins only.");
    const p = z.object({ active: z.boolean() }).safeParse(req.body);
    if (!p.success) return fail(res, 400, "validation_failed", "Send active: true or false.");
    const a = await store().docGet<DevAccount>(DEV_ACCOUNTS, req.params.id);
    if (!a) return fail(res, 404, "not_found", "Developer not found.");
    await store().docPut(DEV_ACCOUNTS, { ...a, active: p.data.active });
    if (!p.data.active) {
      // Disabling a developer also revokes every app they own.
      for (const c of await store().docList<ApiClient>(API_CLIENTS, { ownerType: "developer", ownerId: a.id })) if (c.active) await revokeClient(c, `super_admin:${req.portalUser!.email}`);
      await store().docDeleteWhere("devSessions", { accountId: a.id });
    }
    await recordAudit({ actor: `super_admin:${req.portalUser!.email}`, action: "super.developer.update", detail: `${a.email}: ${p.data.active ? "enabled" : "disabled (apps revoked)"}` });
    ok(res, { updated: true });
  });
  app.post("/api/super/api-apps/:id/revoke", async (req, res) => {
    if (!isSuperAdmin(req.portalUser)) return fail(res, 403, "forbidden", "Super Admins only.");
    const c = await store().docGet<ApiClient>(API_CLIENTS, req.params.id);
    if (!c) return fail(res, 404, "not_found", "API app not found.");
    await revokeClient(c, `super_admin:${req.portalUser!.email}`);
    await recordAudit({ actor: `super_admin:${req.portalUser!.email}`, action: "super.api_app.revoke", detail: `${c.name} (${c.clientId})` });
    ok(res, { revoked: true });
  });
}
