// Admin access control (RBAC): Super Admin, admin roles, modules and actions.
//
// Super Admin   A Healjour admin with isSuperAdmin = true. Signs in at /superadmin (its own console) and can
//               do everything. There is always at least one active Super Admin.
// Admin role    A named set of permissions. A permission is "<module>.<action>", e.g. "orders.view" or
//               "catalog.edit". Healjour admins get one role; no role = built-in "Full access".
// Module        A part of the product (MODULES). Action = view | create | edit | delete | export.
// Enforcement   The admin sidebar hides modules without ".view"; the server maps every admin API call to a
//               module and action (permissionForRequest) and refuses it without that permission.
// Lab users (lab_admin / lab_staff / lab_viewer) keep their lab roles; this file does not limit them.

import { getStore } from "../store.js";
import type { PortalUser } from "./auth.js";

export const MODULES = {
  integrations: { label: "Integrations", description: "Integration Hub (payments, messaging, leads, App Store), connector framework, integrations, core layers" },
  labs: { label: "Labs", description: "Lab cases, partner labs and their users, organizations" },
  catalog: { label: "Catalog & Flabs accounts", description: "Test catalog, test builder, corporate mapping, Flabs account setup and sync" },
  orders: { label: "Orders & bookings", description: "Bookings, pre-bookings, calendar, tracker, results and smart reports" },
  logs: { label: "Transactions & logs", description: "Integration log and its exports" },
  developers: { label: "Developers", description: "API & webhooks, partner API credentials, monitoring" },
  settings: { label: "Settings", description: "Encryption key and public address" }
} as const;
export type ModuleId = keyof typeof MODULES;
export const ALL_MODULES = Object.keys(MODULES) as ModuleId[];

export const ACTIONS = {
  view: "See the pages and read data",
  create: "Create records and run actions (send, sync, run, refund…)",
  edit: "Change existing records and settings",
  delete: "Delete or remove records",
  export: "Download data (CSV, JSON, reports)"
} as const;
export type ActionId = keyof typeof ACTIONS;
export const ALL_ACTIONS = Object.keys(ACTIONS) as ActionId[];
export type PermissionId = `${ModuleId}.${ActionId}`;
export const ALL_PERMISSIONS = ALL_MODULES.flatMap(m => ALL_ACTIONS.map(a => `${m}.${a}` as PermissionId));
export const isPermission = (p: string): p is PermissionId => (ALL_PERMISSIONS as string[]).includes(p);

export type AdminRole = {
  id: string; name: string; description: string;
  permissions: PermissionId[];
  modules?: ModuleId[];          // older roles (before actions): every action on these modules
  builtIn: boolean; createdAt: string; updatedAt: string;
};
export const ROLES_COLLECTION = "adminRoles";
export const FULL_ACCESS: AdminRole = {
  id: "full-access", name: "Full access", description: "Every module and every action (no Super Admin console).",
  permissions: ALL_PERMISSIONS, builtIn: true, createdAt: "", updatedAt: ""
};

/** A role's permissions, upgrading older module-only roles. */
export const rolePermissions = (r: AdminRole): PermissionId[] =>
  (r.permissions?.length ? r.permissions : (r.modules ?? []).flatMap(m => ALL_ACTIONS.map(a => `${m}.${a}` as PermissionId))).filter(isPermission);

export const isSuperAdmin = (u: PortalUser | null | undefined) => Boolean(u && u.role === "healjour_admin" && u.isSuperAdmin);

export async function listAdminRoles(): Promise<AdminRole[]> {
  const custom = await getStore().docList<AdminRole>(ROLES_COLLECTION);
  return [FULL_ACCESS, ...custom.map(r => ({ ...r, permissions: rolePermissions(r) })).sort((a, b) => a.name.localeCompare(b.name))];
}

/** Every permission a user has. Super Admins and lab users are not limited here. */
export async function allowedPermissions(u: PortalUser): Promise<PermissionId[]> {
  if (u.role !== "healjour_admin" || isSuperAdmin(u) || !u.adminRoleId || u.adminRoleId === FULL_ACCESS.id) return ALL_PERMISSIONS;
  const role = await getStore().docGet<AdminRole>(ROLES_COLLECTION, u.adminRoleId);
  return role ? rolePermissions(role) : [];   // a deleted role grants nothing until reassigned
}

/** Modules a user can open (has ".view"). */
export async function allowedModules(u: PortalUser): Promise<ModuleId[]> {
  const perms = await allowedPermissions(u);
  return ALL_MODULES.filter(m => perms.includes(`${m}.view`));
}

const starts = (path: string, ...prefixes: string[]) => prefixes.some(p => path === p || path.startsWith(`${p}/`));

/** Which module an admin API call belongs to (null = shared or not module-specific). */
export function moduleForPath(method: string, path: string): ModuleId | null {
  const write = method !== "GET" && method !== "HEAD";
  if (starts(path, "/api/super")) return null;                       // Super Admin only, checked separately
  if (starts(path, "/api/hub", "/api/framework", "/api/integrations", "/api/core")) return "integrations";
  if (starts(path, "/api/portal/labs", "/api/portal/users")) return "labs";
  if (path === "/api/portal/cases" && write) return "labs";
  if (starts(path, "/api/catalog", "/api/builder", "/api/flabs/test")) return "catalog";
  if (starts(path, "/api/flabs/connections")) {
    // Reading accounts, their corporates and catalogs is shared: the booking forms need them.
    return write ? "catalog" : null;
  }
  if (starts(path, "/api/flabs/bookings", "/api/flabs/prebookings", "/api/flabs/booking-options", "/api/flabs/results", "/api/flabs/parameter-ranges",
    "/api/calendar", "/api/appointments", "/api/staff", "/api/booking-form")) return "orders";
  if (starts(path, "/api/logs")) return "logs";
  if (starts(path, "/api/partner-access")) return "developers";
  if (starts(path, "/api/settings")) return "settings";
  return null;
}

/** The action an HTTP call performs: GET = view (or export for downloads), POST = create, PUT/PATCH = edit, DELETE = delete. */
export function actionForRequest(method: string, path: string, query: Record<string, unknown> = {}): ActionId {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") {
    const download = /\/export(\/|$)|\.(csv|json|ics)$|\/smart-report$|\/consents$/.test(path) || query.format === "csv" || query.format === "json";
    return download ? "export" : "view";
  }
  if (m === "DELETE") return "delete";
  if (m === "PUT" || m === "PATCH") return "edit";
  return "create";
}

export function permissionForRequest(method: string, path: string, query: Record<string, unknown> = {}): PermissionId | null {
  const mod = moduleForPath(method, path);
  return mod ? `${mod}.${actionForRequest(method, path, query)}` : null;
}

// ---------- system settings (Super Admin) ----------
export type SystemSettings = { id: "system"; sessionHours: number; maintenance: boolean; maintenanceMessage: string; updatedAt?: string; updatedBy?: string };
export const DEFAULT_SYSTEM: SystemSettings = { id: "system", sessionHours: 12, maintenance: false, maintenanceMessage: "Healjour is under maintenance. Please try again later." };
export async function getSystemSettings(): Promise<SystemSettings> {
  const doc = await getStore().docGet<SystemSettings>("systemSettings", "system");
  return { ...DEFAULT_SYSTEM, ...(doc ?? {}) };
}

/** Makes sure one Super Admin exists: the earliest active Healjour admin is promoted if none is set. */
export async function ensureSuperAdmin(): Promise<PortalUser | null> {
  const store = getStore();
  const admins = (await store.docList<PortalUser>("portalUsers", { role: "healjour_admin" })).filter(u => u.active);
  if (!admins.length || admins.some(u => u.isSuperAdmin)) return null;
  const first = admins.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  const promoted = { ...first, isSuperAdmin: true };
  await store.docPut("portalUsers", promoted);
  return promoted;
}
