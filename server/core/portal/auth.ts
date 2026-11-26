// Login and role-based access (RBAC) for Healjour staff and partner labs.
//
// Roles
//   healjour_admin  Healjour team: every lab and case. What admin screens they get depends on their admin
//                   role (see access.ts); isSuperAdmin = true adds full control (admins, roles, sessions, audit).
//   lab_admin       One lab: its cases, reports, and its own team (staff and viewers).
//   lab_staff       One lab: its cases; can update status, enter results, upload reports.
//   lab_viewer      One lab: read-only view of its cases and reports.
//
// Passwords are stored as scrypt hashes with a per-user salt. Sessions are random tokens sent as an
// httpOnly, SameSite=Lax cookie; only their SHA-256 hash is stored, with a 12-hour expiry.

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getStore } from "../store.js";
import type { Actor } from "./actor.js";

export const ROLES = ["healjour_admin", "lab_admin", "lab_staff", "lab_viewer"] as const;
export type Role = typeof ROLES[number];
export const LAB_ROLES: Role[] = ["lab_admin", "lab_staff", "lab_viewer"];

export const PERMISSIONS = {
  "admin:all": ["healjour_admin"],
  "labs:manage": ["healjour_admin"],
  "cases:create": ["healjour_admin"],
  "cases:cancel": ["healjour_admin"],
  "cases:read": ["healjour_admin", "lab_admin", "lab_staff", "lab_viewer"],
  "cases:update": ["healjour_admin", "lab_admin", "lab_staff"],
  "reports:upload": ["healjour_admin", "lab_admin", "lab_staff"],
  "team:manage": ["healjour_admin", "lab_admin"]
} as const satisfies Record<string, readonly Role[]>;
export type Permission = keyof typeof PERMISSIONS;

export const can = (role: Role, permission: Permission) => (PERMISSIONS[permission] as readonly Role[]).includes(role);

export type PortalUser = {
  id: string;
  email: string;            // lowercase, unique
  name: string;
  role: Role;
  labId: string | null;     // null only for healjour_admin
  active: boolean;
  passwordHash: string;     // scrypt$<salt hex>$<hash hex>
  mustChangePassword: boolean;
  createdAt: string;
  createdBy: string | null;
  lastLoginAt?: string;
  isSuperAdmin?: boolean;   // healjour_admin only: full control (see access.ts)
  adminRoleId?: string;     // healjour_admin only: which modules they may use; absent = full access
  workspaceIds?: string[];  // healjour_admin only: tenants whose data they see; absent or empty = every workspace (platform admin)
  creator?: Actor;          // who created this account (name + user ID, and the Super Admin if done via "Login as")
};
export type PublicUser = Omit<PortalUser, "passwordHash">;
export type PortalLab = { id: string; code: string; name: string; city?: string; contactEmail?: string; active: boolean; createdAt: string; creator?: Actor };
// impersonatorId: a Super Admin used "Login as" to open this user's account (short session, fully audited).
type Session = { id: string; userId: string; expiresAt: string; createdAt: string; userAgent?: string; impersonatorId?: string; reason?: string };
const IMPERSONATION_MINUTES = 60;

export const USERS = "portalUsers";
export const LABS = "portalLabs";
const SESSIONS = "portalSessions";
export const COOKIE = "hj_session";
const SESSION_HOURS = 12;

export const publicUser = ({ passwordHash: _hidden, ...rest }: PortalUser): PublicUser => rest;

// ---------- passwords ----------

export function hashPassword(password: string) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(password, salt, 64).toString("hex")}`;
}

export function verifyPassword(password: string, stored: string) {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const passwordProblem = (password: string) =>
  password.length < 10 ? "Password must be at least 10 characters." :
  !/[A-Za-z]/.test(password) || !/\d/.test(password) ? "Password needs letters and at least one digit." : null;

/** A readable one-time password for a new user, who must change it at first login. */
export const temporaryPassword = () => `Hj-${randomBytes(6).toString("base64url")}-${Math.floor(10 + Math.random() * 89)}`;

// ---------- sessions ----------

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(user: PortalUser, userAgent?: string, impersonation?: { by: PortalUser; reason: string }) {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  // Session length is set by the Super Admin (Security); 12 hours by default. "Login as" lasts one hour.
  const stored = await getStore().docGet<{ id: string; sessionHours?: number }>("systemSettings", "system");
  const hours = impersonation ? IMPERSONATION_MINUTES / 60
    : stored?.sessionHours && stored.sessionHours >= 1 && stored.sessionHours <= 72 ? stored.sessionHours : SESSION_HOURS;
  await getStore().docPut<Session>(SESSIONS, {
    id: tokenHash(token), userId: user.id, createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + hours * 3600_000).toISOString(), userAgent: userAgent?.slice(0, 200),
    ...(impersonation ? { impersonatorId: impersonation.by.id, reason: impersonation.reason } : {})
  });
  return { token, maxAgeMs: hours * 3600_000 };
}

/** The current session, if it is a "Login as" session: who opened it and why. */
export async function impersonationOf(req: Request): Promise<{ impersonator: PortalUser; reason: string; expiresAt: string } | null> {
  const token = sessionToken(req);
  if (!token) return null;
  const session = await getStore().docGet<Session>(SESSIONS, tokenHash(token));
  if (!session?.impersonatorId) return null;
  const impersonator = await getStore().docGet<PortalUser>(USERS, session.impersonatorId);
  if (!impersonator) return null;
  return { impersonator, reason: session.reason ?? "", expiresAt: session.expiresAt };
}

export async function endSession(token: string | undefined) {
  if (token) await getStore().docDelete(SESSIONS, tokenHash(token));
}

export async function endSessionsForUser(userId: string) {
  await getStore().docDeleteWhere(SESSIONS, { userId });
}

export const readCookie = (req: Request, name: string) => {
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
};
export const sessionToken = (req: Request) => readCookie(req, COOKIE);

export function setSessionCookie(req: Request, res: Response, token: string, maxAgeMs: number) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? "; Secure" : ""}`);
}
export function clearSessionCookie(res: Response) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Several guards ask for the user on one request; look it up once.
const userCache = new WeakMap<Request, Promise<PortalUser | null>>();

/** The signed-in user for this request, or null. Expired sessions and disabled users count as signed out. */
export function currentUser(req: Request): Promise<PortalUser | null> {
  let found = userCache.get(req);
  if (!found) { found = loadCurrentUser(req); userCache.set(req, found); }
  return found;
}

async function loadCurrentUser(req: Request): Promise<PortalUser | null> {
  const token = sessionToken(req);
  if (!token) return null;
  const store = getStore();
  const session = await store.docGet<Session>(SESSIONS, tokenHash(token));
  if (!session) return null;
  if (Date.parse(session.expiresAt) < Date.now()) { await store.docDelete(SESSIONS, session.id); return null; }
  const user = await store.docGet<PortalUser>(USERS, session.userId);
  if (!user || !user.active) return null;
  if (session.impersonatorId) {
    // A "Login as" session ends the moment its Super Admin is disabled or loses Super Admin.
    const by = await store.docGet<PortalUser>(USERS, session.impersonatorId);
    if (!by || !by.active || !by.isSuperAdmin) { await store.docDelete(SESSIONS, session.id); return null; }
    req.actor = { id: user.id, name: user.name, email: user.email, via: { id: by.id, name: by.name, email: by.email } };
  } else {
    req.actor = { id: user.id, name: user.name, email: user.email };
  }
  if (user.labId) {
    const lab = await store.docGet<PortalLab>(LABS, user.labId);
    if (!lab || !lab.active) return null; // a disabled lab locks out all of its users
  }
  return user;
}

declare module "express-serve-static-core" {
  interface Request { portalUser?: PortalUser }
}

/** Express guard: signed in, and the role has the permission. */
export function requirePermission(permission: Permission) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: "Please sign in." });
    if (!can(user.role, permission)) return res.status(403).json({ error: "Your role does not allow this." });
    req.portalUser = user;
    next();
  };
}

// ---------- login throttling ----------

const failures = new Map<string, { count: number; first: number }>();
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;

export function loginBlocked(key: string) {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW_MS) { failures.delete(key); return false; }
  return f.count >= MAX_FAILURES;
}
export function recordLoginFailure(key: string) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > WINDOW_MS) failures.set(key, { count: 1, first: Date.now() });
  else f.count += 1;
}
export const clearLoginFailures = (key: string) => failures.delete(key);

export async function hasAnyUser() {
  return (await getStore().docList<PortalUser>(USERS)).length > 0;
}
