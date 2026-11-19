// Lab Portal API: sign-in, labs and their teams, and the cases (bookings) Healjour sends to each lab.
// Labs update status, enter results and upload reports; every change lands in Healjour's logs and audit.
// Lab users only ever see their own lab's data: every query below is scoped by the signed-in user's labId.

import { allowedModules, allowedPermissions, ensureSuperAdmin, getSystemSettings, isSuperAdmin } from "./core/portal/access.js";
import type express from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { getStore } from "./core/store.js";
import { logIntegration } from "./core/logs.js";
import { recordAudit } from "./core/identity.js";
import {
  can, clearLoginFailures, clearSessionCookie, createSession, currentUser, endSession, endSessionsForUser,
  hashPassword, hasAnyUser, LAB_ROLES, LABS, loginBlocked, passwordProblem, PERMISSIONS, publicUser,
  recordLoginFailure, requirePermission, ROLES, sessionToken, setSessionCookie, temporaryPassword, USERS, verifyPassword,
  type PortalLab, type PortalUser, type Role
} from "./core/portal/auth.js";

// ---------- cases ----------

export const CASE_STATUSES = ["new", "accepted", "sample_collected", "processing", "report_ready", "completed", "rejected", "cancelled"] as const;
type CaseStatus = typeof CASE_STATUSES[number];
const FINAL: CaseStatus[] = ["completed", "rejected", "cancelled"];

/** What a lab may move a case to from each status. Healjour admins may also cancel any open case. */
const LAB_NEXT: Record<CaseStatus, CaseStatus[]> = {
  new: ["accepted", "rejected"],
  accepted: ["sample_collected", "rejected"],
  sample_collected: ["processing"],
  processing: ["report_ready"],
  report_ready: ["completed", "processing"],
  completed: [], rejected: [], cancelled: []
};

type ResultRow = { testCode: string; testName: string; value: string; unit: string; referenceRange: string; flag: "" | "normal" | "low" | "high" | "abnormal" };
type ReportMeta = { id: string; fileName: string; mimeType: string; size: number; uploadedAt: string; uploadedBy: string; note?: string };
type TimelineEntry = { at: string; by: string; role: Role | "system"; action: string; status?: CaseStatus; note?: string };
export type LabCase = {
  id: string; caseNo: string; labId: string; labName: string;
  patient: { name: string; age: number; ageUnit: "year" | "month" | "day"; gender: "male" | "female" | "other"; phone?: string; healjourId?: string };
  tests: Array<{ code: string; name: string }>;
  priority: "routine" | "urgent" | "stat";
  collection: "home" | "lab_visit";
  scheduledAt?: string; notes?: string;
  status: CaseStatus;
  results: ResultRow[];
  reports: ReportMeta[];
  timeline: TimelineEntry[];
  createdAt: string; createdBy: string; updatedAt: string;
  lastLabUpdateAt?: string;   // newest change made by the lab
  adminSeenAt?: string;       // when a Healjour admin last opened it
};
type StoredReport = { id: string; caseId: string; labId: string; fileName: string; mimeType: string; size: number; dataBase64: string; uploadedAt: string };

const CASES = "labCases";
const REPORTS = "labCaseReports";
const MAX_REPORT_BYTES = 3 * 1024 * 1024; // keeps the upload under Vercel's 4.5 MB request limit
const REPORT_TYPES = ["application/pdf", "image/png", "image/jpeg"];

const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const caseNo = () => {
  const d = new Date();
  return `HJ-${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${randomBytes(2).toString("hex").toUpperCase()}`;
};
const issues = (e: z.ZodError) => e.issues.map(i => `${i.path.join(".") || "body"}: ${i.message}`).join(" ");

/** The case if this user may see it (own lab, or any lab for Healjour admins). */
async function scopedCase(user: PortalUser, id: string) {
  const c = await getStore().docGet<LabCase>(CASES, id);
  if (!c) return undefined;
  if (user.role !== "healjour_admin" && c.labId !== user.labId) return undefined;
  return c;
}

const summary = (c: LabCase) => ({
  id: c.id, caseNo: c.caseNo, labId: c.labId, labName: c.labName, patient: c.patient, tests: c.tests,
  priority: c.priority, collection: c.collection, scheduledAt: c.scheduledAt, status: c.status,
  reportCount: c.reports.length, resultCount: c.results.length, createdAt: c.createdAt, updatedAt: c.updatedAt,
  lastLabUpdateAt: c.lastLabUpdateAt, unseen: Boolean(c.lastLabUpdateAt && (!c.adminSeenAt || c.adminSeenAt < c.lastLabUpdateAt))
});

/** A lab-side change is "received" by Healjour: timeline, integration log and audit trail. */
async function recordLabUpdate(c: LabCase, user: PortalUser, action: string, extra: Partial<TimelineEntry> = {}) {
  const at = new Date().toISOString();
  c.timeline.push({ at, by: user.name, role: user.role, action, ...extra });
  c.updatedAt = at;
  if (user.role !== "healjour_admin") c.lastLabUpdateAt = at;
  await getStore().docPut(CASES, c);
  await logIntegration({
    type: "lab_portal", status: "success", account: c.labName,
    title: user.role === "healjour_admin" ? `Case ${c.caseNo}: ${action}` : `Lab update received: ${c.caseNo}`,
    message: `${action}${extra.status ? ` (status ${extra.status})` : ""} by ${user.name}.`,
    integratorID: c.caseNo
  });
  await recordAudit({ actor: `${user.role}:${user.email}`, action: "lab_portal.case.update", detail: `${c.caseNo} (${c.labName}): ${action}` });
}

const STATUS_WORDS: Record<CaseStatus, string> = {
  new: "New", accepted: "Accepted", sample_collected: "Sample collected", processing: "Processing",
  report_ready: "Report ready", completed: "Completed", rejected: "Rejected", cancelled: "Cancelled"
};

export function registerPortalRoutes(app: express.Express) {
  // ---------- sign-in ----------

  app.get("/api/auth/state", async (req, res) => {
    await ensureSuperAdmin();
    const user = await currentUser(req);
    const lab = user?.labId ? await getStore().docGet<PortalLab>(LABS, user.labId) : null;
    res.json({
      setupNeeded: !(await hasAnyUser()),
      setupKeyRequired: Boolean(process.env.PORTAL_SETUP_KEY?.trim()),
      user: user ? publicUser(user) : null,
      lab: lab ?? null,
      permissions: user ? Object.keys(PERMISSIONS).filter(p => can(user.role, p as keyof typeof PERMISSIONS)) : [],
      modules: user ? await allowedModules(user) : [],
      adminPermissions: user?.role === "healjour_admin" ? await allowedPermissions(user) : [],
      superAdmin: isSuperAdmin(user)
    });
  });

  // First run only: create the first Healjour admin. Closed for good once any user exists.
  app.post("/api/auth/setup", async (req, res) => {
    if (await hasAnyUser()) return res.status(409).json({ error: "Setup is already done. Please sign in." });
    const parsed = z.object({
      name: z.string().trim().min(2).max(80), email: z.string().trim().toLowerCase().email(),
      password: z.string().max(200), setupKey: z.string().optional()
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: issues(parsed.error) });
    const key = process.env.PORTAL_SETUP_KEY?.trim();
    if (key && parsed.data.setupKey !== key) return res.status(403).json({ error: "Setup key is not correct." });
    const problem = passwordProblem(parsed.data.password);
    if (problem) return res.status(400).json({ error: problem });
    const user: PortalUser = {
      id: newId("usr"), email: parsed.data.email, name: parsed.data.name, role: "healjour_admin", labId: null,
      active: true, passwordHash: hashPassword(parsed.data.password), mustChangePassword: false,
      createdAt: new Date().toISOString(), createdBy: null, isSuperAdmin: true   // the first admin controls everything
    };
    await getStore().docPut(USERS, user);
    await recordAudit({ actor: `healjour_admin:${user.email}`, action: "lab_portal.setup", detail: "First Healjour admin created." });
    const { token, maxAgeMs } = await createSession(user, req.headers["user-agent"]);
    setSessionCookie(req, res, token, maxAgeMs);
    res.json({ ok: true, user: publicUser(user) });
  });

  app.post("/api/auth/login", async (req, res) => {
    const parsed = z.object({
      email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200),
      area: z.enum(["admin", "lab", "super"]).optional() // which sign-in page was used
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Enter your email and password." });
    const key = `${parsed.data.email}|${req.ip}`;
    if (loginBlocked(key)) return res.status(429).json({ error: "Too many wrong attempts. Try again in 15 minutes." });
    const users = await getStore().docList<PortalUser>(USERS, { email: parsed.data.email });
    const user = users[0];
    // Same message whether the email or the password is wrong.
    if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
      recordLoginFailure(key);
      return res.status(401).json({ error: "Email or password is not correct." });
    }
    if (!user.active) return res.status(403).json({ error: "This account is disabled. Ask your admin." });
    // Admins sign in at /admin, labs at the main address. Checked after the password, so it reveals nothing to a guesser.
    if (parsed.data.area === "admin" && user.role !== "healjour_admin") return res.status(403).json({ error: "This is the Healjour admin sign-in. Lab users sign in on the main Lab Portal page." });
    if (parsed.data.area === "lab" && user.role === "healjour_admin") return res.status(403).json({ error: "Healjour admins sign in at /admin." });
    if (parsed.data.area === "super" && !isSuperAdmin(user)) return res.status(403).json({ error: "This sign-in is only for Super Admins. Admins sign in at /admin." });
    const system = await getSystemSettings();
    if (system.maintenance && !isSuperAdmin(user)) return res.status(503).json({ error: system.maintenanceMessage });
    if (user.labId) {
      const lab = await getStore().docGet<PortalLab>(LABS, user.labId);
      if (!lab?.active) return res.status(403).json({ error: "This lab's access is paused. Contact Healjour." });
    }
    clearLoginFailures(key);
    user.lastLoginAt = new Date().toISOString();
    await getStore().docPut(USERS, user);
    const { token, maxAgeMs } = await createSession(user, req.headers["user-agent"]);
    setSessionCookie(req, res, token, maxAgeMs);
    await recordAudit({ actor: `${user.role}:${user.email}`, action: "lab_portal.login", detail: "Signed in." });
    res.json({ ok: true, user: publicUser(user) });
  });

  app.post("/api/auth/logout", async (req, res) => {
    await endSession(sessionToken(req));
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.post("/api/auth/password", async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: "Please sign in." });
    const parsed = z.object({ current: z.string().max(200), next: z.string().max(200) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Enter both passwords." });
    if (!verifyPassword(parsed.data.current, user.passwordHash)) return res.status(400).json({ error: "Current password is not correct." });
    const problem = passwordProblem(parsed.data.next);
    if (problem) return res.status(400).json({ error: problem });
    user.passwordHash = hashPassword(parsed.data.next);
    user.mustChangePassword = false;
    await getStore().docPut(USERS, user);
    await endSessionsForUser(user.id); // sign out other devices
    const { token, maxAgeMs } = await createSession(user, req.headers["user-agent"]);
    setSessionCookie(req, res, token, maxAgeMs);
    res.json({ ok: true, message: "Password changed." });
  });

  // ---------- labs (Healjour admin) ----------

  app.get("/api/portal/labs", requirePermission("labs:manage"), async (_req, res) => {
    const store = getStore();
    const [labs, users, cases] = await Promise.all([store.docList<PortalLab>(LABS), store.docList<PortalUser>(USERS), store.docList<LabCase>(CASES)]);
    res.json({
      labs: labs.sort((a, b) => a.name.localeCompare(b.name)).map(l => ({
        ...l,
        users: users.filter(u => u.labId === l.id).length,
        openCases: cases.filter(c => c.labId === l.id && !FINAL.includes(c.status)).length,
        unseen: cases.filter(c => c.labId === l.id && summary(c).unseen).length
      }))
    });
  });

  const labSchema = z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{3,30}$/, "Code: 3-30 letters, digits or -"),
    name: z.string().trim().min(2).max(100),
    city: z.string().trim().max(60).optional(),
    contactEmail: z.string().trim().email().optional().or(z.literal("")),
    active: z.boolean().optional()
  });

  app.post("/api/portal/labs", requirePermission("labs:manage"), async (req, res) => {
    const parsed = labSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: issues(parsed.error) });
    const store = getStore();
    if ((await store.docList<PortalLab>(LABS, { code: parsed.data.code })).length) return res.status(409).json({ error: "A lab with this code exists." });
    const lab: PortalLab = { id: newId("lab"), code: parsed.data.code, name: parsed.data.name, city: parsed.data.city || undefined, contactEmail: parsed.data.contactEmail || undefined, active: true, createdAt: new Date().toISOString() };
    await store.docPut(LABS, lab);
    await recordAudit({ actor: `healjour_admin:${req.portalUser!.email}`, action: "lab_portal.lab.create", detail: `${lab.code} ${lab.name}` });
    res.json({ ok: true, lab });
  });

  app.put("/api/portal/labs/:id", requirePermission("labs:manage"), async (req, res) => {
    const store = getStore();
    const lab = await store.docGet<PortalLab>(LABS, String(req.params.id));
    if (!lab) return res.status(404).json({ error: "Lab not found." });
    const parsed = labSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: issues(parsed.error) });
    const next = { ...lab, ...Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)) } as PortalLab;
    next.code = lab.code; // the code identifies the lab in case numbers and logs
    await store.docPut(LABS, next);
    await recordAudit({ actor: `healjour_admin:${req.portalUser!.email}`, action: "lab_portal.lab.update", detail: `${lab.code}: ${next.active ? "active" : "paused"}` });
    res.json({ ok: true, lab: next });
  });

  // ---------- team (Healjour admin: anyone; lab admin: own lab's staff and viewers) ----------

  // Healjour admins manage lab users; only a Super Admin manages Healjour admins.
  const mayManage = (actor: PortalUser, target: { role: Role; labId: string | null }) =>
    (actor.role === "healjour_admin" && (target.role !== "healjour_admin" || isSuperAdmin(actor))) ||
    (actor.role === "lab_admin" && target.labId === actor.labId && (target.role === "lab_staff" || target.role === "lab_viewer"));

  app.get("/api/portal/users", requirePermission("team:manage"), async (req, res) => {
    const actor = req.portalUser!;
    const labId = actor.role === "healjour_admin" ? (typeof req.query.labId === "string" ? req.query.labId : undefined) : actor.labId!;
    const users = await getStore().docList<PortalUser>(USERS, labId ? { labId } : undefined);
    res.json({ users: users.sort((a, b) => a.name.localeCompare(b.name)).map(publicUser) });
  });

  app.post("/api/portal/users", requirePermission("team:manage"), async (req, res) => {
    const actor = req.portalUser!;
    const parsed = z.object({
      name: z.string().trim().min(2).max(80), email: z.string().trim().toLowerCase().email(),
      role: z.enum(ROLES), labId: z.string().nullable().optional()
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: issues(parsed.error) });
    const labId = actor.role === "healjour_admin" ? (parsed.data.labId ?? null) : actor.labId;
    if (parsed.data.role === "healjour_admin" && labId) return res.status(400).json({ error: "Healjour admins do not belong to a lab." });
    if (LAB_ROLES.includes(parsed.data.role) && !labId) return res.status(400).json({ error: "Choose the lab for this user." });
    if (!mayManage(actor, { role: parsed.data.role, labId })) return res.status(403).json({ error: "You can add only staff and viewers to your own lab." });
    const store = getStore();
    if (labId && !(await store.docGet<PortalLab>(LABS, labId))) return res.status(404).json({ error: "Lab not found." });
    if ((await store.docList<PortalUser>(USERS, { email: parsed.data.email })).length) return res.status(409).json({ error: "A user with this email exists." });
    const password = temporaryPassword();
    const user: PortalUser = {
      id: newId("usr"), email: parsed.data.email, name: parsed.data.name, role: parsed.data.role, labId: labId ?? null,
      active: true, passwordHash: hashPassword(password), mustChangePassword: true, createdAt: new Date().toISOString(), createdBy: actor.id
    };
    await store.docPut(USERS, user);
    await recordAudit({ actor: `${actor.role}:${actor.email}`, action: "lab_portal.user.create", detail: `${user.email} as ${user.role}${labId ? ` (${labId})` : ""}` });
    // The one-time password is shown once to the person who created the user; it is never stored in plain text.
    res.json({ ok: true, user: publicUser(user), temporaryPassword: password });
  });

  app.put("/api/portal/users/:id", requirePermission("team:manage"), async (req, res) => {
    const actor = req.portalUser!;
    const store = getStore();
    const user = await store.docGet<PortalUser>(USERS, String(req.params.id));
    if (!user || !mayManage(actor, user)) return res.status(404).json({ error: "User not found." });
    const parsed = z.object({ name: z.string().trim().min(2).max(80).optional(), role: z.enum(ROLES).optional(), active: z.boolean().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: issues(parsed.error) });
    if (user.id === actor.id && (parsed.data.active === false || (parsed.data.role && parsed.data.role !== user.role))) {
      return res.status(400).json({ error: "You cannot disable yourself or change your own role." });
    }
    const role = parsed.data.role ?? user.role;
    if (role === "healjour_admin" && user.labId) return res.status(400).json({ error: "Lab users cannot become Healjour admins." });
    if (LAB_ROLES.includes(role) && !user.labId) return res.status(400).json({ error: "Healjour admins cannot get a lab role." });
    if (!mayManage(actor, { role, labId: user.labId })) return res.status(403).json({ error: "You can manage only staff and viewers of your own lab." });
    const next = { ...user, name: parsed.data.name ?? user.name, role, active: parsed.data.active ?? user.active };
    await store.docPut(USERS, next);
    if (!next.active || next.role !== user.role) await endSessionsForUser(user.id);
    await recordAudit({ actor: `${actor.role}:${actor.email}`, action: "lab_portal.user.update", detail: `${user.email}: ${next.role}, ${next.active ? "active" : "disabled"}` });
    res.json({ ok: true, user: publicUser(next) });
  });

  app.post("/api/portal/users/:id/reset-password", requirePermission("team:manage"), async (req, res) => {
    const actor = req.portalUser!;
    const store = getStore();
    const user = await store.docGet<PortalUser>(USERS, String(req.params.id));
    if (!user || !mayManage(actor, user)) return res.status(404).json({ error: "User not found." });
    const password = temporaryPassword();
    await store.docPut(USERS, { ...user, passwordHash: hashPassword(password), mustChangePassword: true });
    await endSessionsForUser(user.id);
    await recordAudit({ actor: `${actor.role}:${actor.email}`, action: "lab_portal.user.reset_password", detail: user.email });
    res.json({ ok: true, temporaryPassword: password });
  });

  // ---------- cases ----------

  // Flabs booking form: which patient fields are shown, required, renamed, reordered, or added.
  const FORM_SETTINGS = "bookingFormSettings";
  const LOCKED_FORM_FIELDS = ["first_name", "contact", "age"];
  const formFieldSchema = z.object({
    key: z.string().min(1).max(60).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    label: z.string().trim().min(1).max(80),
    type: z.enum(["text", "number", "date", "datetime", "select", "textarea"]),
    visible: z.boolean(),
    required: z.boolean(),
    options: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
    custom: z.boolean().optional(),
    defaultValue: z.string().max(200).optional()
  });
  app.get("/api/booking-form/settings", requirePermission("labs:manage"), async (_req, res) => {
    const saved = await getStore().docGet<{ id: string; fields: unknown[] }>(FORM_SETTINGS, "default");
    res.json({ fields: saved?.fields ?? null });
  });
  app.put("/api/booking-form/settings", requirePermission("labs:manage"), async (req, res) => {
    const parsed = z.object({ fields: z.array(formFieldSchema).min(1).max(80) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: issues(parsed.error) });
    const keys = parsed.data.fields.map(f => f.key);
    if (new Set(keys).size !== keys.length) return res.status(400).json({ error: "Each field needs a unique key." });
    const fields = parsed.data.fields.map(f => LOCKED_FORM_FIELDS.includes(f.key) ? { ...f, visible: true, required: true } : f);
    for (const k of LOCKED_FORM_FIELDS) if (!keys.includes(k)) return res.status(400).json({ error: `The ${k} field cannot be removed.` });
    await getStore().docPut(FORM_SETTINGS, { id: "default", fields, updatedAt: new Date().toISOString(), updatedBy: req.portalUser!.name });
    res.json({ ok: true, fields });
  });

  // Notifications = the newest case-timeline events the user may see (own lab, or all labs for Healjour admins).
  app.get("/api/portal/notifications", requirePermission("cases:read"), async (req, res) => {
    const user = req.portalUser!;
    const where: Record<string, unknown> = {};
    if (user.role !== "healjour_admin") where.labId = user.labId;
    const cases = await getStore().docList<LabCase>(CASES, where);
    const caseItems = cases.flatMap(c => c.timeline.map((t, i) => ({
      id: `${c.id}:${i}`, caseId: c.id, caseNo: c.caseNo, labName: c.labName,
      action: t.action, note: t.note, status: t.status, by: t.by, role: t.role, at: t.at,
      fromLab: t.role !== "healjour_admin" && t.role !== "system", reportUrl: undefined as string | undefined
    })));
    // Flabs report links (bill.completed webhooks) are for Healjour admins only.
    let flabsItems: typeof caseItems = [];
    if (user.role === "healjour_admin") {
      const logs = await getStore().listIntegrationLogs(300);
      flabsItems = logs
        .filter(l => l.type === "webhook" && (l.details ?? []).some(d => d.startsWith("Report: ")))
        .map(l => ({
          id: `flabs:${l.id}`, caseId: "", caseNo: l.integratorID ?? l.leadId ?? "", labName: l.account,
          action: l.title, note: l.message, status: undefined, by: "Flabs", role: "system", at: l.at,
          fromLab: false,
          reportUrl: (l.details ?? []).find(d => d.startsWith("Report: "))!.slice("Report: ".length).trim()
        }));
    }
    const items = [...caseItems, ...flabsItems]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 60);
    res.json({ items });
  });

  app.get("/api/portal/cases", requirePermission("cases:read"), async (req, res) => {
    const user = req.portalUser!;
    const where: Record<string, unknown> = {};
    if (user.role !== "healjour_admin") where.labId = user.labId;
    else if (typeof req.query.labId === "string" && req.query.labId) where.labId = req.query.labId;
    if (typeof req.query.status === "string" && (CASE_STATUSES as readonly string[]).includes(req.query.status)) where.status = req.query.status;
    const cases = await getStore().docList<LabCase>(CASES, where);
    res.json({
      cases: cases.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(summary),
      statuses: CASE_STATUSES.map(s => ({ value: s, label: STATUS_WORDS[s] }))
    });
  });

  app.get("/api/portal/cases/:id", requirePermission("cases:read"), async (req, res) => {
    const user = req.portalUser!;
    const c = await scopedCase(user, String(req.params.id));
    if (!c) return res.status(404).json({ error: "Case not found." });
    if (user.role === "healjour_admin") {
      c.adminSeenAt = new Date().toISOString();
      await getStore().docPut(CASES, c);
    }
    const nextStatuses = can(user.role, "cases:update") ? LAB_NEXT[c.status] : [];
    const canCancel = can(user.role, "cases:cancel") && !FINAL.includes(c.status);
    res.json({ case: c, nextStatuses: [...nextStatuses, ...(canCancel ? ["cancelled"] : [])].map(s => ({ value: s, label: STATUS_WORDS[s as CaseStatus] })) });
  });

  // Healjour sends a booking to a lab.
  app.post("/api/portal/cases", requirePermission("cases:create"), async (req, res) => {
    const user = req.portalUser!;
    const parsed = z.object({
      labId: z.string().min(1),
      patient: z.object({
        name: z.string().trim().min(2).max(100), age: z.number().int().min(0).max(150),
        ageUnit: z.enum(["year", "month", "day"]).default("year"), gender: z.enum(["male", "female", "other"]),
        phone: z.string().trim().regex(/^\d{10}$/, "Phone must be 10 digits.").optional().or(z.literal("")),
        healjourId: z.string().trim().max(60).optional()
      }),
      tests: z.array(z.object({ code: z.string().min(1).max(30), name: z.string().min(1).max(120) })).min(1, "Choose at least one test.").max(100),
      priority: z.enum(["routine", "urgent", "stat"]).default("routine"),
      collection: z.enum(["home", "lab_visit"]).default("lab_visit"),
      scheduledAt: z.string().datetime({ offset: true }).optional(),
      notes: z.string().trim().max(1000).optional()
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: issues(parsed.error) });
    const store = getStore();
    const lab = await store.docGet<PortalLab>(LABS, parsed.data.labId);
    if (!lab) return res.status(404).json({ error: "Lab not found." });
    if (!lab.active) return res.status(400).json({ error: "This lab is paused. Activate it first." });
    const now = new Date().toISOString();
    const c: LabCase = {
      id: newId("case"), caseNo: caseNo(), labId: lab.id, labName: lab.name,
      patient: { ...parsed.data.patient, phone: parsed.data.patient.phone || undefined },
      tests: parsed.data.tests, priority: parsed.data.priority, collection: parsed.data.collection,
      scheduledAt: parsed.data.scheduledAt, notes: parsed.data.notes || undefined,
      status: "new", results: [], reports: [],
      timeline: [{ at: now, by: user.name, role: user.role, action: "Booking sent to lab", status: "new" }],
      createdAt: now, createdBy: user.id, updatedAt: now, adminSeenAt: now
    };
    await store.docPut(CASES, c);
    await logIntegration({
      type: "lab_portal", status: "success", account: lab.name, title: `Case ${c.caseNo} sent to lab`,
      message: `${c.patient.name}, ${c.tests.length} test(s), ${c.priority}.`, integratorID: c.caseNo
    });
    await recordAudit({ actor: `${user.role}:${user.email}`, action: "lab_portal.case.create", detail: `${c.caseNo} to ${lab.code}` });
    res.json({ ok: true, case: summary(c) });
  });

  app.post("/api/portal/cases/:id/status", requirePermission("cases:read"), async (req, res) => {
    const user = req.portalUser!;
    const c = await scopedCase(user, String(req.params.id));
    if (!c) return res.status(404).json({ error: "Case not found." });
    const parsed = z.object({ status: z.enum(CASE_STATUSES), note: z.string().trim().max(500).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Choose a valid status." });
    if (!can(user.role, "cases:update") && !can(user.role, "cases:cancel")) return res.status(403).json({ error: "Your role can only view cases." });
    const to = parsed.data.status;
    const allowed = to === "cancelled"
      ? can(user.role, "cases:cancel") && !FINAL.includes(c.status)
      : can(user.role, "cases:update") && LAB_NEXT[c.status].includes(to);
    if (!allowed) return res.status(400).json({ error: `A case that is "${STATUS_WORDS[c.status]}" cannot move to "${STATUS_WORDS[to]}" for your role.` });
    if ((to === "rejected" || to === "cancelled") && !parsed.data.note) return res.status(400).json({ error: "Give a reason." });
    if (to === "report_ready" && c.reports.length === 0) return res.status(400).json({ error: "Upload the report first." });
    const from = c.status;
    c.status = to;
    await recordLabUpdate(c, user, `${STATUS_WORDS[from]} → ${STATUS_WORDS[to]}`, { status: to, note: parsed.data.note });
    res.json({ ok: true, case: summary(c) });
  });

  app.put("/api/portal/cases/:id/results", requirePermission("cases:update"), async (req, res) => {
    const user = req.portalUser!;
    const c = await scopedCase(user, String(req.params.id));
    if (!c) return res.status(404).json({ error: "Case not found." });
    if (FINAL.includes(c.status)) return res.status(400).json({ error: "This case is closed." });
    const parsed = z.object({
      results: z.array(z.object({
        testCode: z.string().min(1).max(30), testName: z.string().max(120).default(""),
        value: z.string().trim().max(60), unit: z.string().trim().max(30).default(""),
        referenceRange: z.string().trim().max(60).default(""), flag: z.enum(["", "normal", "low", "high", "abnormal"]).default("")
      })).max(200)
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: issues(parsed.error) });
    c.results = parsed.data.results.filter(r => r.value !== "");
    await recordLabUpdate(c, user, `Results entered (${c.results.length})`);
    res.json({ ok: true, results: c.results });
  });

  app.post("/api/portal/cases/:id/reports", requirePermission("reports:upload"), async (req, res) => {
    const user = req.portalUser!;
    const c = await scopedCase(user, String(req.params.id));
    if (!c) return res.status(404).json({ error: "Case not found." });
    if (FINAL.includes(c.status)) return res.status(400).json({ error: "This case is closed." });
    const parsed = z.object({
      fileName: z.string().trim().min(1).max(160), mimeType: z.string(), dataBase64: z.string().min(1), note: z.string().trim().max(300).optional()
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Choose a file." });
    if (!REPORT_TYPES.includes(parsed.data.mimeType)) return res.status(400).json({ error: "Upload a PDF, PNG or JPEG file." });
    const bytes = Buffer.from(parsed.data.dataBase64, "base64");
    if (!bytes.length) return res.status(400).json({ error: "The file is empty." });
    if (bytes.length > MAX_REPORT_BYTES) return res.status(400).json({ error: "The file is larger than 3 MB." });
    const pdfMagic = bytes.subarray(0, 4).toString("latin1") === "%PDF";
    const pngMagic = bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const jpgMagic = bytes[0] === 0xff && bytes[1] === 0xd8;
    const okType = parsed.data.mimeType === "application/pdf" ? pdfMagic : parsed.data.mimeType === "image/png" ? pngMagic : jpgMagic;
    if (!okType) return res.status(400).json({ error: "The file content does not match its type." });
    const meta: ReportMeta = {
      id: newId("rpt"), fileName: parsed.data.fileName.replace(/[^\w.\- ()]+/g, "_"), mimeType: parsed.data.mimeType,
      size: bytes.length, uploadedAt: new Date().toISOString(), uploadedBy: user.name, note: parsed.data.note || undefined
    };
    await getStore().docPut<StoredReport>(REPORTS, { id: meta.id, caseId: c.id, labId: c.labId, fileName: meta.fileName, mimeType: meta.mimeType, size: meta.size, dataBase64: bytes.toString("base64"), uploadedAt: meta.uploadedAt });
    c.reports.push(meta);
    await recordLabUpdate(c, user, `Report uploaded: ${meta.fileName}`, { note: meta.note });
    res.json({ ok: true, report: meta });
  });

  app.get("/api/portal/cases/:id/reports/:reportId", requirePermission("cases:read"), async (req, res) => {
    const c = await scopedCase(req.portalUser!, String(req.params.id));
    if (!c) return res.status(404).json({ error: "Case not found." });
    const r = await getStore().docGet<StoredReport>(REPORTS, String(req.params.reportId));
    if (!r || r.caseId !== c.id) return res.status(404).json({ error: "Report not found." });
    const data = Buffer.from(r.dataBase64, "base64");
    res.setHeader("Content-Type", r.mimeType);
    res.setHeader("Content-Length", String(data.length));
    res.setHeader("Content-Disposition", `attachment; filename="${r.fileName.replace(/"/g, "")}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.end(data);
  });

  app.post("/api/portal/cases/:id/notes", requirePermission("cases:read"), async (req, res) => {
    const user = req.portalUser!;
    const c = await scopedCase(user, String(req.params.id));
    if (!c) return res.status(404).json({ error: "Case not found." });
    if (user.role === "lab_viewer") return res.status(403).json({ error: "Viewers cannot add notes." });
    const parsed = z.object({ note: z.string().trim().min(1).max(1000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Write a note." });
    await recordLabUpdate(c, user, "Note added", { note: parsed.data.note });
    res.json({ ok: true });
  });
}
