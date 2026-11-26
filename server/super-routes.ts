// Super Admin console API. The module guard in app.ts lets only Super Admins reach /api/super/*.
// Every change is written to the hash-chained audit trail.

import type express from "express";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { getStore } from "./core/store.js";
import { listAudit, recordAudit, verifyAuditChain } from "./core/identity.js";
import {
  createSession, endSession, endSessionsForUser, hashPassword, LABS, publicUser, sessionToken, setSessionCookie, temporaryPassword, USERS,
  type PortalLab, type PortalUser
} from "./core/portal/auth.js";
import { actorOf as requestActor, type Actor } from "./core/portal/actor.js";
import {
  ACTIONS, ALL_ACTIONS, ALL_MODULES, ALL_PAGES, ALL_PERMISSIONS, FULL_ACCESS, getSystemSettings, isPageId, isPermission, isSuperAdmin, listAdminRoles, MODULES, PAGES,
  rolePages, rolePermissions, ROLES_COLLECTION, WORKSPACE_PAGES, type AdminRole, type PageId, type PermissionId, type SystemSettings
} from "./core/portal/access.js";
import { listWorkspaces, nextTenantId, WORKSPACES, workspaceTagger, type Workspace } from "./core/portal/tenancy.js";
import { listConnectionViews } from "./core/flabs/connection.js";
import { getHealthCheckSettings, HEALTHCHECK_HOUR_IST, listHealthCheckRuns, runHealthCheck, saveHealthCheckSettings } from "./core/hub/healthcheck.js";
import { isJobId, jobOverview, runNow, setJobEnabled } from "./core/hub/scheduler.js";

const SESSIONS = "portalSessions";
type Session = { id: string; userId: string; expiresAt: string; createdAt: string; userAgent?: string };
const zerr = (e: z.ZodError) => e.issues.map(i => `${i.path.join(".") || "body"}: ${i.message}`).join(" ");
const now = () => new Date().toISOString();
const newId = (p: string) => `${p}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const actorOf = (req: express.Request) => `super_admin:${req.portalUser?.email ?? "?"}`;

export function registerSuperRoutes(app: express.Express) {
  const store = () => getStore();
  const admins = async () => (await store().docList<PortalUser>(USERS, { role: "healjour_admin" }));
  const activeSuperAdmins = async () => (await admins()).filter(u => u.active && u.isSuperAdmin);
  // Accounts made before creators were recorded only have createdBy (a user ID): show that person.
  const creatorOf = (u: PortalUser, all: PortalUser[]): Actor | null => {
    if (u.creator) return u.creator;
    const by = u.createdBy ? all.find(x => x.id === u.createdBy) : undefined;
    return by ? { id: by.id, name: by.name, email: by.email } : u.createdBy ? { id: u.createdBy, name: "Deleted user", email: "" } : null;
  };
  const roleName = (roles: AdminRole[], id?: string) => (roles.find(r => r.id === (id ?? FULL_ACCESS.id)) ?? { name: "Role deleted: no access" }).name;

  // ---------- overview ----------
  app.get("/api/super/overview", async (_req, res) => {
    const [users, labs, sessions, roles, audit, chain, workspaces] = await Promise.all([
      store().docList<PortalUser>(USERS), store().docList<PortalLab>(LABS), store().docList<Session>(SESSIONS),
      listAdminRoles(), listAudit(15), verifyAuditChain(), listWorkspaces()
    ]);
    const live = sessions.filter(s => Date.parse(s.expiresAt) > Date.now());
    res.json({
      counts: {
        workspaces: workspaces.length,
        admins: users.filter(u => u.role === "healjour_admin").length,
        superAdmins: users.filter(u => u.role === "healjour_admin" && u.isSuperAdmin).length,
        labs: labs.length, activeLabs: labs.filter(l => l.active).length,
        labUsers: users.filter(u => u.role !== "healjour_admin").length,
        disabledUsers: users.filter(u => !u.active).length,
        activeSessions: live.length, roles: roles.length
      },
      auditChain: chain, recentAudit: audit, modules: MODULES, system: await getSystemSettings()
    });
  });

  // ---------- admins ----------
  // Workspace access: [] (or absent) = every workspace and the platform pages; ids = only those workspaces.
  const workspaceIdsSchema = z.array(z.string().min(1).max(80)).max(200);
  const unknownWorkspace = async (ids?: string[]) => {
    if (!ids?.length) return null;
    const known = new Set((await listWorkspaces()).map(w => w.id));
    return ids.find(id => !known.has(id)) ?? null;
  };
  const scopeText = (ws: Workspace[], ids?: string[]) => ids?.length ? ws.filter(w => ids.includes(w.id)).map(w => w.code).join(", ") || "none" : "all workspaces";

  app.get("/api/super/admins", async (_req, res) => {
    const [roles, workspaces] = await Promise.all([listAdminRoles(), listWorkspaces()]);
    const pagesByRole = new Map(roles.map(role => [role.id, rolePages(role)]));
    const sessions = (await store().docList<Session>(SESSIONS)).filter(s => Date.parse(s.expiresAt) > Date.now());
    const effective = (u: PortalUser): PageId[] => {
      if (u.isSuperAdmin) return ALL_PAGES;
      const pages = pagesByRole.get(u.adminRoleId ?? FULL_ACCESS.id) ?? [];
      return u.workspaceIds?.length ? pages.filter(id => WORKSPACE_PAGES.includes(id)) : pages;
    };
    const everyone = await store().docList<PortalUser>(USERS);
    res.json({
      admins: (await admins()).sort((a, b) => a.name.localeCompare(b.name)).map(u => ({
        ...publicUser(u), creator: creatorOf(u, everyone), roleName: u.isSuperAdmin ? "Super Admin" : roleName(roles, u.adminRoleId),
        effectivePages: effective(u),
        activeSessions: sessions.filter(s => s.userId === u.id).length
      })),
      roles, pages: PAGES,
      workspaces: workspaces.map(w => ({ id: w.id, tenantId: w.tenantId, code: w.code, name: w.name, active: w.active }))
    });
  });

  app.post("/api/super/admins", async (req, res) => {
    const p = z.object({
      name: z.string().trim().min(2).max(80), email: z.string().trim().toLowerCase().email(),
      adminRoleId: z.string().min(1).max(80).optional(), isSuperAdmin: z.boolean().optional(),
      workspaceIds: workspaceIdsSchema.optional()
    }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    if ((await store().docList<PortalUser>(USERS, { email: p.data.email })).length) return res.status(409).json({ error: "A user with this email exists." });
    const roles = await listAdminRoles();
    if (p.data.adminRoleId && !roles.some(r => r.id === p.data.adminRoleId)) return res.status(400).json({ error: "Unknown admin role." });
    if (await unknownWorkspace(p.data.workspaceIds)) return res.status(400).json({ error: "Unknown workspace." });
    const workspaceIds = p.data.isSuperAdmin ? [] : [...new Set(p.data.workspaceIds ?? [])];
    const password = temporaryPassword();
    const user: PortalUser = {
      id: newId("usr"), email: p.data.email, name: p.data.name, role: "healjour_admin", labId: null, active: true,
      passwordHash: hashPassword(password), mustChangePassword: true, createdAt: now(), createdBy: req.portalUser!.id,
      isSuperAdmin: Boolean(p.data.isSuperAdmin), ...(p.data.adminRoleId && p.data.adminRoleId !== FULL_ACCESS.id ? { adminRoleId: p.data.adminRoleId } : {}),
      ...(workspaceIds.length ? { workspaceIds } : {}), creator: requestActor(req)
    };
    await store().docPut(USERS, user);
    await recordAudit({ actor: actorOf(req), action: "super.admin.create", detail: `${user.email} as ${user.isSuperAdmin ? "Super Admin" : roleName(roles, user.adminRoleId)}, ${scopeText(await listWorkspaces(), user.workspaceIds)}` });
    res.json({ ok: true, user: publicUser(user), temporaryPassword: password });
  });

  app.put("/api/super/admins/:id", async (req, res) => {
    const p = z.object({
      name: z.string().trim().min(2).max(80).optional(), active: z.boolean().optional(),
      adminRoleId: z.string().min(1).max(80).optional(), isSuperAdmin: z.boolean().optional(),
      workspaceIds: workspaceIdsSchema.optional()
    }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    const user = await store().docGet<PortalUser>(USERS, String(req.params.id));
    if (!user || user.role !== "healjour_admin") return res.status(404).json({ error: "Admin not found." });
    const self = user.id === req.portalUser!.id;
    if (self && (p.data.active === false || p.data.isSuperAdmin === false)) return res.status(400).json({ error: "You cannot disable yourself or remove your own Super Admin access." });
    const losingSuper = user.isSuperAdmin && user.active && (p.data.active === false || p.data.isSuperAdmin === false);
    if (losingSuper && (await activeSuperAdmins()).length <= 1) return res.status(400).json({ error: "There must always be at least one active Super Admin." });
    const roles = await listAdminRoles();
    if (p.data.adminRoleId && !roles.some(r => r.id === p.data.adminRoleId)) return res.status(400).json({ error: "Unknown admin role." });
    if (await unknownWorkspace(p.data.workspaceIds)) return res.status(400).json({ error: "Unknown workspace." });
    const next: PortalUser = {
      ...user, name: p.data.name ?? user.name, active: p.data.active ?? user.active,
      isSuperAdmin: p.data.isSuperAdmin ?? user.isSuperAdmin,
      adminRoleId: p.data.adminRoleId === undefined ? user.adminRoleId : p.data.adminRoleId === FULL_ACCESS.id ? undefined : p.data.adminRoleId,
      workspaceIds: p.data.workspaceIds === undefined ? user.workspaceIds : [...new Set(p.data.workspaceIds)]
    };
    if (!next.workspaceIds?.length || next.isSuperAdmin) delete next.workspaceIds;
    await store().docPut(USERS, next);
    if (!next.active) await endSessionsForUser(user.id);
    const workspaceChange = p.data.workspaceIds !== undefined && (user.workspaceIds ?? []).join(",") !== (next.workspaceIds ?? []).join(",")
      ? `workspaces → ${scopeText(await listWorkspaces(), next.workspaceIds)}` : "";
    const changes = [
      workspaceChange,
      p.data.active !== undefined && p.data.active !== user.active ? (next.active ? "enabled" : "disabled") : "",
      p.data.isSuperAdmin !== undefined && p.data.isSuperAdmin !== Boolean(user.isSuperAdmin) ? (next.isSuperAdmin ? "made Super Admin" : "Super Admin removed") : "",
      p.data.adminRoleId !== undefined && (p.data.adminRoleId === FULL_ACCESS.id ? undefined : p.data.adminRoleId) !== user.adminRoleId ? `role → ${roleName(roles, next.adminRoleId)}` : "",
      p.data.name && p.data.name !== user.name ? `renamed to ${next.name}` : ""
    ].filter(Boolean).join(", ") || "no change";
    await recordAudit({ actor: actorOf(req), action: "super.admin.update", detail: `${user.email}: ${changes}` });
    res.json({ ok: true, user: publicUser(next) });
  });

  app.post("/api/super/admins/:id/reset-password", async (req, res) => {
    const user = await store().docGet<PortalUser>(USERS, String(req.params.id));
    if (!user || user.role !== "healjour_admin") return res.status(404).json({ error: "Admin not found." });
    if (user.id === req.portalUser!.id) return res.status(400).json({ error: "Change your own password from your profile." });
    const password = temporaryPassword();
    await store().docPut(USERS, { ...user, passwordHash: hashPassword(password), mustChangePassword: true });
    await endSessionsForUser(user.id);
    await recordAudit({ actor: actorOf(req), action: "super.admin.reset_password", detail: user.email });
    res.json({ ok: true, temporaryPassword: password });
  });

  // ---------- every user (labs too): enable / disable / sign out ----------
  app.get("/api/super/users", async (_req, res) => {
    const [users, labs, tags, workspaces] = await Promise.all([store().docList<PortalUser>(USERS), store().docList<PortalLab>(LABS), workspaceTagger(), listWorkspaces()]);
    const labName = new Map(labs.map(l => [l.id, l.name]));
    res.json({
      users: users.sort((a, b) => a.name.localeCompare(b.name)).map(u => ({
        ...publicUser(u), creator: creatorOf(u, users), labName: u.labId ? labName.get(u.labId) ?? u.labId : null,
        // Lab users belong to their lab's workspace; admins to the workspaces they were given (none = all).
        workspaces: u.labId ? [tags.lab(u.labId)].filter(Boolean)
          : workspaces.filter(w => u.workspaceIds?.includes(w.id)).map(w => ({ id: w.id, tenantId: w.tenantId, name: w.name }))
      }))
    });
  });
  app.put("/api/super/users/:id", async (req, res) => {
    const p = z.object({ active: z.boolean() }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    const user = await store().docGet<PortalUser>(USERS, String(req.params.id));
    if (!user) return res.status(404).json({ error: "User not found." });
    if (user.id === req.portalUser!.id) return res.status(400).json({ error: "You cannot disable yourself." });
    if (user.isSuperAdmin && user.active && !p.data.active && (await activeSuperAdmins()).length <= 1) return res.status(400).json({ error: "There must always be at least one active Super Admin." });
    await store().docPut(USERS, { ...user, active: p.data.active });
    if (!p.data.active) await endSessionsForUser(user.id);
    await recordAudit({ actor: actorOf(req), action: "super.user.update", detail: `${user.email}: ${p.data.active ? "enabled" : "disabled"}` });
    res.json({ ok: true });
  });
  // "Login as": the Super Admin opens this user's account for one hour to see exactly what they see.
  // Not for other Super Admins or disabled users; a reason is required and everything done is audited
  // with both names. The user's own sessions are untouched.
  app.post("/api/super/users/:id/impersonate", async (req, res) => {
    const p = z.object({ reason: z.string().trim().min(5, "Give a reason (at least 5 characters).").max(200) }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    const me = req.portalUser!;
    const user = await store().docGet<PortalUser>(USERS, String(req.params.id));
    if (!user) return res.status(404).json({ error: "User not found." });
    if (user.id === me.id) return res.status(400).json({ error: "You are already signed in as yourself." });
    if (isSuperAdmin(user)) return res.status(403).json({ error: "You cannot log in as another Super Admin." });
    if (!user.active) return res.status(400).json({ error: "This user is disabled. Enable them first." });
    if (user.labId) {
      const lab = await store().docGet<PortalLab>(LABS, user.labId);
      if (!lab?.active) return res.status(400).json({ error: "This user's lab is paused. Resume it first." });
    }
    const { token, maxAgeMs } = await createSession(user, req.headers["user-agent"], { by: me, reason: p.data.reason });
    // The Super Admin's own session is ended; "Return to Super Admin" starts a fresh one.
    await endSession(sessionToken(req));
    setSessionCookie(req, res, token, maxAgeMs);
    await recordAudit({ actor: actorOf(req), action: "super.impersonation.start", detail: `Logged in as ${user.email} (${user.role}) for 1 hour. Reason: ${p.data.reason}` });
    res.json({ ok: true, redirect: user.role === "healjour_admin" ? "/admin" : "/" });
  });

  app.post("/api/super/users/:id/sign-out", async (req, res) => {
    const user = await store().docGet<PortalUser>(USERS, String(req.params.id));
    if (!user) return res.status(404).json({ error: "User not found." });
    await endSessionsForUser(user.id);
    await recordAudit({ actor: actorOf(req), action: "super.user.sign_out", detail: `All sessions of ${user.email} ended` });
    res.json({ ok: true });
  });

  // ---------- admin roles (permission = "<module>.<action>") ----------
  const roleBody = z.object({
    name: z.string().trim().min(2).max(60), description: z.string().trim().max(200).default(""),
    permissions: z.array(z.string()).max(ALL_PERMISSIONS.length),
    pages: z.array(z.string().refine(isPageId, "Unknown admin page.")).max(ALL_PAGES.length).optional()
  });
  const cleanPerms = (list: string[]) => [...new Set(list.filter(isPermission))] as PermissionId[];
  const describe = (perms: PermissionId[]) => perms.length ? ALL_MODULES.map(m => {
    const acts = ALL_ACTIONS.filter(a => perms.includes(`${m}.${a}` as PermissionId));
    return acts.length ? `${MODULES[m].label}: ${acts.join("/")}` : "";
  }).filter(Boolean).join("; ") : "no permissions";
  const pageDiff = (next: AdminRole, previous?: AdminRole) => {
    const before = previous ? rolePages(previous) : [];
    const after = rolePages(next);
    return `pages +[${after.filter(id => !before.includes(id)).join(", ")}] -[${before.filter(id => !after.includes(id)).join(", ")}]`;
  };
  app.get("/api/super/roles", async (_req, res) => {
    const roles = await listAdminRoles();
    const all = await admins();
    res.json({
      roles: roles.map(r => ({
        ...r, effectivePages: rolePages(r),
        admins: all.filter(u => !u.isSuperAdmin && (u.adminRoleId ?? FULL_ACCESS.id) === r.id).length
      })),
      modules: MODULES, actions: ACTIONS, pages: PAGES
    });
  });
  app.post("/api/super/roles", async (req, res) => {
    const p = roleBody.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    if ((await listAdminRoles()).some(r => r.name.toLowerCase() === p.data.name.toLowerCase())) return res.status(409).json({ error: "A role with this name exists." });
    const role: AdminRole = {
      id: newId("role"), name: p.data.name, description: p.data.description, permissions: cleanPerms(p.data.permissions),
      pages: p.data.pages && [...new Set(p.data.pages)], builtIn: false, createdAt: now(), updatedAt: now(),
      creator: requestActor(req), updater: requestActor(req)
    };
    await store().docPut(ROLES_COLLECTION, role);
    await recordAudit({ actor: actorOf(req), action: "super.role.create", detail: `${role.name}: ${describe(role.permissions)}; ${pageDiff(role)}` });
    res.json({ ok: true, role });
  });
  app.put("/api/super/roles/:id", async (req, res) => {
    const role = await store().docGet<AdminRole>(ROLES_COLLECTION, String(req.params.id));
    if (!role) return res.status(404).json({ error: req.params.id === FULL_ACCESS.id ? "The built-in Full access role cannot be changed." : "Role not found." });
    const p = roleBody.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    const before = rolePermissions(role);
    const next: AdminRole = {
      ...role, name: p.data.name, description: p.data.description, permissions: cleanPerms(p.data.permissions),
      modules: undefined, pages: p.data.pages ? [...new Set(p.data.pages)] : role.pages, updatedAt: now(),
      updater: requestActor(req)
    };
    await store().docPut(ROLES_COLLECTION, next);
    const added = next.permissions.filter(x => !before.includes(x)), removed = before.filter(x => !next.permissions.includes(x));
    await recordAudit({ actor: actorOf(req), action: "super.role.update", detail: `${next.name}: +[${added.join(", ")}] -[${removed.join(", ")}]; ${pageDiff(next, role)}` });
    res.json({ ok: true, role: next });
  });
  app.delete("/api/super/roles/:id", async (req, res) => {
    const role = await store().docGet<AdminRole>(ROLES_COLLECTION, String(req.params.id));
    if (!role) return res.status(404).json({ error: "Role not found." });
    const using = (await admins()).filter(u => u.adminRoleId === role.id);
    if (using.length) return res.status(400).json({ error: `${using.length} admin(s) still have this role. Give them another role first.` });
    await store().docDelete(ROLES_COLLECTION, role.id);
    await recordAudit({ actor: actorOf(req), action: "super.role.delete", detail: role.name });
    res.json({ ok: true });
  });

  // ---------- scheduled jobs: on/off and run now ----------
  app.get("/api/super/jobs", async (_req, res) => {
    res.json({ jobs: await jobOverview(), onVercel: Boolean(process.env.VERCEL), cronConfigured: Boolean(process.env.CRON_SECRET?.trim()) });
  });
  app.put("/api/super/jobs/:id", async (req, res) => {
    const id = String(req.params.id);
    if (!isJobId(id)) return res.status(404).json({ error: "Unknown job." });
    const p = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: "Send enabled: true or false." });
    await setJobEnabled(id, p.data.enabled, req.portalUser!.email);
    await recordAudit({ actor: actorOf(req), action: "super.job.update", detail: `${id}: ${p.data.enabled ? "ON" : "off"}` });
    res.json({ ok: true, jobs: await jobOverview() });
  });
  app.post("/api/super/jobs/:id/run", async (req, res) => {
    const id = String(req.params.id);
    if (!isJobId(id)) return res.status(404).json({ error: "Unknown job." });
    await recordAudit({ actor: actorOf(req), action: "super.job.run", detail: `${id}: run now` });
    const run = await runNow(id, req.portalUser!.email);
    res.json({ ok: true, run, jobs: await jobOverview() });
  });

  // ---------- daily booking health check (test destinations only) ----------
  app.get("/api/super/healthcheck", async (_req, res) => {
    const [settings, runs, labs] = await Promise.all([getHealthCheckSettings(), listHealthCheckRuns(), store().docList<PortalLab>(LABS)]);
    res.json({
      settings, runs, hourIst: HEALTHCHECK_HOUR_IST, cronConfigured: Boolean(process.env.CRON_SECRET?.trim()), onVercel: Boolean(process.env.VERCEL),
      // Billing (pre-booking) needs a lead source from Flabs; say up front which accounts are not ready.
      flabsAccounts: await Promise.all(listConnectionViews().map(async c => {
        const pre = await store().getPrebookingSettings(c.id);
        const leadSource = pre?.defaultLeadSource || pre?.leadSources?.[0] || null;
        return { id: c.id, label: c.label, phase: c.phase, leadSource, billingReady: Boolean(leadSource) };
      })),
      labs: labs.sort((a, b) => a.name.localeCompare(b.name)).map(l => ({ id: l.id, name: l.name, code: l.code, active: l.active }))
    });
  });
  app.put("/api/super/healthcheck", async (req, res) => {
    const p = z.object({
      enabled: z.boolean(), perDestination: z.number().int().min(1).max(10),
      flabs: z.array(z.object({ connectionId: z.string().min(1).max(120), billing: z.boolean(), booking: z.boolean() })).max(100),
      labIds: z.array(z.string().min(1).max(80)).max(200)
    }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    const flabs = p.data.flabs.filter(f => f.billing || f.booking);
    await saveHealthCheckSettings({ ...p.data, flabs, updatedAt: now(), updatedBy: req.portalUser!.email });
    await recordAudit({ actor: actorOf(req), action: "super.healthcheck.update", detail: `${p.data.enabled ? "ON" : "off"}, ${p.data.perDestination}/destination, ${flabs.length} Flabs account(s), ${p.data.labIds.length} lab(s)` });
    res.json({ ok: true, settings: await getHealthCheckSettings() });
  });
  app.post("/api/super/healthcheck/run", async (req, res) => {
    await recordAudit({ actor: actorOf(req), action: "super.healthcheck.run", detail: "Run now" });
    res.json({ ok: true, run: await runHealthCheck(`manual by ${req.portalUser!.email}`) });
  });

  // ---------- workspaces (tenants): each owns partner labs and Flabs accounts ----------
  const workspaceBody = z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,30}$/, "Code: 2-30 letters, digits or -"),
    name: z.string().trim().min(2).max(80),
    description: z.string().trim().max(300).default(""),
    labIds: z.array(z.string().min(1).max(80)).max(500).default([]),
    connectionIds: z.array(z.string().min(1).max(120)).max(500).default([]),
    active: z.boolean().default(true)
  });
  /** A lab or account belongs to one workspace only: the first conflict, or null. */
  const ownershipConflict = (all: Workspace[], selfId: string | null, labIds: string[], connectionIds: string[]) => {
    for (const w of all) {
      if (w.id === selfId) continue;
      const lab = labIds.find(id => w.labIds.includes(id));
      if (lab) return { kind: "lab", id: lab, workspace: w };
      const conn = connectionIds.find(id => w.connectionIds.includes(id));
      if (conn) return { kind: "Flabs account", id: conn, workspace: w };
    }
    return null;
  };

  app.get("/api/super/workspaces", async (_req, res) => {
    const [workspaces, labs, all] = await Promise.all([listWorkspaces(), store().docList<PortalLab>(LABS), admins()]);
    res.json({
      workspaces: workspaces.map(w => ({ ...w, admins: all.filter(u => !u.isSuperAdmin && u.workspaceIds?.includes(w.id)).length })),
      labs: labs.sort((a, b) => a.name.localeCompare(b.name)).map(l => ({ id: l.id, code: l.code, name: l.name, active: l.active })),
      connections: listConnectionViews().map(c => ({ id: c.id, label: c.label })).sort((a, b) => a.label.localeCompare(b.label)),
      platformAdmins: all.filter(u => !u.isSuperAdmin && !u.workspaceIds?.length).length
    });
  });

  const saveWorkspace = async (req: express.Request, res: express.Response, existing: Workspace | null) => {
    const p = workspaceBody.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    const all = await listWorkspaces();
    if (all.some(w => w.id !== existing?.id && w.code === p.data.code)) return res.status(409).json({ error: "A workspace with this code exists." });
    const labIds = [...new Set(p.data.labIds)], connectionIds = [...new Set(p.data.connectionIds)];
    const knownLabs = new Set((await store().docList<PortalLab>(LABS)).map(l => l.id));
    const knownConns = new Set(listConnectionViews().map(c => c.id));
    if (labIds.some(id => !knownLabs.has(id)) || connectionIds.some(id => !knownConns.has(id))) return res.status(400).json({ error: "Unknown lab or Flabs account." });
    const conflict = ownershipConflict(all, existing?.id ?? null, labIds, connectionIds);
    if (conflict) return res.status(409).json({ error: `That ${conflict.kind} already belongs to workspace ${conflict.workspace.name}. Remove it there first.` });
    const who = requestActor(req);
    const ws: Workspace = {
      id: existing?.id ?? newId("ws"), tenantId: existing?.tenantId || await nextTenantId(),
      code: p.data.code, name: p.data.name, description: p.data.description,
      labIds, connectionIds, active: p.data.active, createdAt: existing?.createdAt ?? now(), updatedAt: now(),
      creator: existing ? existing.creator : who, updater: who
    };
    await store().docPut(WORKSPACES, ws);
    const diff = (a: string[], b: string[]) => a.filter(x => !b.includes(x)).length;
    await recordAudit({
      actor: actorOf(req), action: existing ? "super.workspace.update" : "super.workspace.create",
      detail: `${ws.tenantId} ${ws.code} ${ws.name}: ${labIds.length} lab(s), ${connectionIds.length} account(s)${ws.active ? "" : ", paused"}` +
        (existing ? ` (labs +${diff(labIds, existing.labIds)}/-${diff(existing.labIds, labIds)}, accounts +${diff(connectionIds, existing.connectionIds)}/-${diff(existing.connectionIds, connectionIds)})` : "")
    });
    res.json({ ok: true, workspace: ws });
  };
  app.post("/api/super/workspaces", (req, res) => saveWorkspace(req, res, null));
  app.put("/api/super/workspaces/:id", async (req, res) => {
    const ws = await store().docGet<Workspace>(WORKSPACES, String(req.params.id));
    if (!ws) return res.status(404).json({ error: "Workspace not found." });
    return saveWorkspace(req, res, ws);
  });
  app.delete("/api/super/workspaces/:id", async (req, res) => {
    const ws = await store().docGet<Workspace>(WORKSPACES, String(req.params.id));
    if (!ws) return res.status(404).json({ error: "Workspace not found." });
    const members = (await admins()).filter(u => u.workspaceIds?.includes(ws.id));
    if (members.length) return res.status(400).json({ error: `${members.length} admin(s) still work in this workspace. Change their workspace access first.` });
    await store().docDelete(WORKSPACES, ws.id);
    await recordAudit({ actor: actorOf(req), action: "super.workspace.delete", detail: `${ws.code} ${ws.name} (its labs and accounts are now unassigned)` });
    res.json({ ok: true });
  });

  // ---------- labs: pause / resume a whole lab (its users are locked out while paused) ----------
  app.get("/api/super/labs", async (_req, res) => {
    const [labs, users, tags] = await Promise.all([store().docList<PortalLab>(LABS), store().docList<PortalUser>(USERS), workspaceTagger()]);
    res.json({ labs: labs.sort((a, b) => a.name.localeCompare(b.name)).map(l => ({ ...l, users: users.filter(u => u.labId === l.id).length, workspace: tags.lab(l.id) })) });
  });
  app.put("/api/super/labs/:id", async (req, res) => {
    const p = z.object({ active: z.boolean() }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    const lab = await store().docGet<PortalLab>(LABS, String(req.params.id));
    if (!lab) return res.status(404).json({ error: "Lab not found." });
    await store().docPut(LABS, { ...lab, active: p.data.active });
    if (!p.data.active) for (const u of await store().docList<PortalUser>(USERS, { labId: lab.id })) await endSessionsForUser(u.id);
    await recordAudit({ actor: actorOf(req), action: "super.lab.update", detail: `${lab.name}: ${p.data.active ? "resumed" : "paused (users signed out)"}` });
    res.json({ ok: true });
  });

  // ---------- system: session length, maintenance mode ----------
  app.get("/api/super/system", async (_req, res) => res.json(await getSystemSettings()));
  app.put("/api/super/system", async (req, res) => {
    const p = z.object({
      sessionHours: z.number().int().min(1).max(72), maintenance: z.boolean(), maintenanceMessage: z.string().trim().min(5).max(300)
    }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    const before = await getSystemSettings();
    const next: SystemSettings = { id: "system", ...p.data, updatedAt: now(), updatedBy: req.portalUser!.email };
    await store().docPut("systemSettings", next);
    // Turning maintenance on signs out everyone except Super Admins.
    if (next.maintenance && !before.maintenance) {
      for (const u of await store().docList<PortalUser>(USERS)) if (!isSuperAdmin(u)) await endSessionsForUser(u.id);
    }
    await recordAudit({ actor: actorOf(req), action: "super.system.update", detail: `session ${next.sessionHours} h, maintenance ${next.maintenance ? "ON" : "off"}` });
    res.json({ ok: true, settings: next });
  });

  // ---------- sessions ----------
  app.get("/api/super/sessions", async (req, res) => {
    const mine = createHash("sha256").update(sessionToken(req) ?? "").digest("hex");
    const [sessions, users] = await Promise.all([store().docList<Session>(SESSIONS), store().docList<PortalUser>(USERS)]);
    const byId = new Map(users.map(u => [u.id, u]));
    res.json({
      sessions: sessions.filter(s => Date.parse(s.expiresAt) > Date.now()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(s => {
        const u = byId.get(s.userId);
        return { id: s.id, createdAt: s.createdAt, expiresAt: s.expiresAt, userAgent: s.userAgent ?? "", current: s.id === mine,
          user: u ? { id: u.id, name: u.name, email: u.email, role: u.role, isSuperAdmin: Boolean(u.isSuperAdmin) } : null };
      })
    });
  });
  app.delete("/api/super/sessions/:id", async (req, res) => {
    const s = await store().docGet<Session>(SESSIONS, String(req.params.id));
    if (!s) return res.status(404).json({ error: "Session not found." });
    await store().docDelete(SESSIONS, s.id);
    const u = await store().docGet<PortalUser>(USERS, s.userId);
    await recordAudit({ actor: actorOf(req), action: "super.session.revoke", detail: `Session of ${u?.email ?? s.userId} ended` });
    res.json({ ok: true });
  });

  // ---------- audit ----------
  app.get("/api/super/audit", async (req, res) => {
    const limit = Math.min(1000, Math.max(10, Number(req.query.limit) || 200));
    const q = String(req.query.q ?? "").trim().toLowerCase();
    const events = (await listAudit(limit)).filter(e => !q || `${e.actor} ${e.action} ${e.detail}`.toLowerCase().includes(q));
    res.json({ events, chain: await verifyAuditChain() });
  });

  // Who am I (for the console header).
  app.get("/api/super/me", (req, res) => res.json({ superAdmin: isSuperAdmin(req.portalUser), user: req.portalUser ? publicUser(req.portalUser) : null }));
}
