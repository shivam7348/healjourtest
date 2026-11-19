// Super Admin console API. The module guard in app.ts lets only Super Admins reach /api/super/*.
// Every change is written to the hash-chained audit trail.

import type express from "express";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { getStore } from "./core/store.js";
import { listAudit, recordAudit, verifyAuditChain } from "./core/identity.js";
import {
  endSessionsForUser, hashPassword, LABS, publicUser, sessionToken, temporaryPassword, USERS,
  type PortalLab, type PortalUser
} from "./core/portal/auth.js";
import {
  ACTIONS, ALL_ACTIONS, ALL_MODULES, ALL_PERMISSIONS, FULL_ACCESS, getSystemSettings, isPermission, isSuperAdmin, listAdminRoles, MODULES,
  rolePermissions, ROLES_COLLECTION, type AdminRole, type PermissionId, type SystemSettings
} from "./core/portal/access.js";

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
  const roleName = (roles: AdminRole[], id?: string) => (roles.find(r => r.id === (id ?? FULL_ACCESS.id)) ?? { name: "Role deleted: no access" }).name;

  // ---------- overview ----------
  app.get("/api/super/overview", async (_req, res) => {
    const [users, labs, sessions, roles, audit, chain] = await Promise.all([
      store().docList<PortalUser>(USERS), store().docList<PortalLab>(LABS), store().docList<Session>(SESSIONS),
      listAdminRoles(), listAudit(15), verifyAuditChain()
    ]);
    const live = sessions.filter(s => Date.parse(s.expiresAt) > Date.now());
    res.json({
      counts: {
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
  app.get("/api/super/admins", async (_req, res) => {
    const roles = await listAdminRoles();
    const sessions = (await store().docList<Session>(SESSIONS)).filter(s => Date.parse(s.expiresAt) > Date.now());
    res.json({
      admins: (await admins()).sort((a, b) => a.name.localeCompare(b.name)).map(u => ({
        ...publicUser(u), roleName: u.isSuperAdmin ? "Super Admin" : roleName(roles, u.adminRoleId),
        activeSessions: sessions.filter(s => s.userId === u.id).length
      })),
      roles
    });
  });

  app.post("/api/super/admins", async (req, res) => {
    const p = z.object({
      name: z.string().trim().min(2).max(80), email: z.string().trim().toLowerCase().email(),
      adminRoleId: z.string().min(1).max(80).optional(), isSuperAdmin: z.boolean().optional()
    }).safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    if ((await store().docList<PortalUser>(USERS, { email: p.data.email })).length) return res.status(409).json({ error: "A user with this email exists." });
    const roles = await listAdminRoles();
    if (p.data.adminRoleId && !roles.some(r => r.id === p.data.adminRoleId)) return res.status(400).json({ error: "Unknown admin role." });
    const password = temporaryPassword();
    const user: PortalUser = {
      id: newId("usr"), email: p.data.email, name: p.data.name, role: "healjour_admin", labId: null, active: true,
      passwordHash: hashPassword(password), mustChangePassword: true, createdAt: now(), createdBy: req.portalUser!.id,
      isSuperAdmin: Boolean(p.data.isSuperAdmin), ...(p.data.adminRoleId && p.data.adminRoleId !== FULL_ACCESS.id ? { adminRoleId: p.data.adminRoleId } : {})
    };
    await store().docPut(USERS, user);
    await recordAudit({ actor: actorOf(req), action: "super.admin.create", detail: `${user.email} as ${user.isSuperAdmin ? "Super Admin" : roleName(roles, user.adminRoleId)}` });
    res.json({ ok: true, user: publicUser(user), temporaryPassword: password });
  });

  app.put("/api/super/admins/:id", async (req, res) => {
    const p = z.object({
      name: z.string().trim().min(2).max(80).optional(), active: z.boolean().optional(),
      adminRoleId: z.string().min(1).max(80).optional(), isSuperAdmin: z.boolean().optional()
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
    const next: PortalUser = {
      ...user, name: p.data.name ?? user.name, active: p.data.active ?? user.active,
      isSuperAdmin: p.data.isSuperAdmin ?? user.isSuperAdmin,
      adminRoleId: p.data.adminRoleId === undefined ? user.adminRoleId : p.data.adminRoleId === FULL_ACCESS.id ? undefined : p.data.adminRoleId
    };
    await store().docPut(USERS, next);
    if (!next.active) await endSessionsForUser(user.id);
    const changes = [
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
    const [users, labs] = await Promise.all([store().docList<PortalUser>(USERS), store().docList<PortalLab>(LABS)]);
    const labName = new Map(labs.map(l => [l.id, l.name]));
    res.json({ users: users.sort((a, b) => a.name.localeCompare(b.name)).map(u => ({ ...publicUser(u), labName: u.labId ? labName.get(u.labId) ?? u.labId : null })) });
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
    permissions: z.array(z.string()).max(ALL_PERMISSIONS.length)
  });
  const cleanPerms = (list: string[]) => [...new Set(list.filter(isPermission))] as PermissionId[];
  const describe = (perms: PermissionId[]) => perms.length ? ALL_MODULES.map(m => {
    const acts = ALL_ACTIONS.filter(a => perms.includes(`${m}.${a}` as PermissionId));
    return acts.length ? `${MODULES[m].label}: ${acts.join("/")}` : "";
  }).filter(Boolean).join("; ") : "no permissions";
  app.get("/api/super/roles", async (_req, res) => {
    const roles = await listAdminRoles();
    const all = await admins();
    res.json({
      roles: roles.map(r => ({ ...r, admins: all.filter(u => !u.isSuperAdmin && (u.adminRoleId ?? FULL_ACCESS.id) === r.id).length })),
      modules: MODULES, actions: ACTIONS
    });
  });
  app.post("/api/super/roles", async (req, res) => {
    const p = roleBody.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    if ((await listAdminRoles()).some(r => r.name.toLowerCase() === p.data.name.toLowerCase())) return res.status(409).json({ error: "A role with this name exists." });
    const role: AdminRole = { id: newId("role"), name: p.data.name, description: p.data.description, permissions: cleanPerms(p.data.permissions), builtIn: false, createdAt: now(), updatedAt: now() };
    await store().docPut(ROLES_COLLECTION, role);
    await recordAudit({ actor: actorOf(req), action: "super.role.create", detail: `${role.name}: ${describe(role.permissions)}` });
    res.json({ ok: true, role });
  });
  app.put("/api/super/roles/:id", async (req, res) => {
    const role = await store().docGet<AdminRole>(ROLES_COLLECTION, String(req.params.id));
    if (!role) return res.status(404).json({ error: req.params.id === FULL_ACCESS.id ? "The built-in Full access role cannot be changed." : "Role not found." });
    const p = roleBody.safeParse(req.body);
    if (!p.success) return res.status(400).json({ error: zerr(p.error) });
    const before = rolePermissions(role);
    const next: AdminRole = { ...role, name: p.data.name, description: p.data.description, permissions: cleanPerms(p.data.permissions), modules: undefined, updatedAt: now() };
    await store().docPut(ROLES_COLLECTION, next);
    const added = next.permissions.filter(x => !before.includes(x)), removed = before.filter(x => !next.permissions.includes(x));
    await recordAudit({ actor: actorOf(req), action: "super.role.update", detail: `${next.name}: +[${added.join(", ")}] -[${removed.join(", ")}]` });
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

  // ---------- labs: pause / resume a whole lab (its users are locked out while paused) ----------
  app.get("/api/super/labs", async (_req, res) => {
    const [labs, users] = await Promise.all([store().docList<PortalLab>(LABS), store().docList<PortalUser>(USERS)]);
    res.json({ labs: labs.sort((a, b) => a.name.localeCompare(b.name)).map(l => ({ ...l, users: users.filter(u => u.labId === l.id).length })) });
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
