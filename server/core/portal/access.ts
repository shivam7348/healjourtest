// Admin access control (RBAC): Super Admin, admin roles, modules and actions.
//
// Super Admin   A Healjour admin with isSuperAdmin = true. Signs in at /superadmin (its own console) and can
//               do everything. There is always at least one active Super Admin.
// Admin role    A named set of permissions. A permission is "<module>.<action>", e.g. "orders.view" or
//               "catalog.edit". Healjour admins get one role; no role = built-in "Full access".
// Module        A part of the product (MODULES). Action = view | create | edit | delete | export.
// Enforcement   The sidebar and API require page access in addition to the module's action permissions.
// Lab users (lab_admin / lab_staff / lab_viewer) keep their lab roles; this file does not limit them.

import { getStore } from "../store.js";
import type { PortalUser } from "./auth.js";
import type { Actor } from "./actor.js";
import { ALL_PAGES, PAGES, PAGE_API_PREFIXES, WORKSPACE_PAGES, type PageId } from "../../../src/lib/admin-pages.js";
export { ALL_PAGES, PAGES, WORKSPACE_PAGES, isPageId, type PageId } from "../../../src/lib/admin-pages.js";

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
  pages?: PageId[];              // omitted or empty: all pages of the modules with view access
  builtIn: boolean; createdAt: string; updatedAt: string;
  creator?: Actor; updater?: Actor;
};
export const ROLES_COLLECTION = "adminRoles";
export const FULL_ACCESS: AdminRole = {
  id: "full-access", name: "Full access", description: "Every module and every action (no Super Admin console).",
  permissions: ALL_PERMISSIONS, builtIn: true, createdAt: "", updatedAt: ""
};

/** A role's permissions, upgrading older module-only roles. */
export const rolePermissions = (r: AdminRole): PermissionId[] =>
  (r.permissions?.length ? r.permissions : (r.modules ?? []).flatMap(m => ALL_ACTIONS.map(a => `${m}.${a}` as PermissionId))).filter(isPermission);

export function rolePages(role: AdminRole, permissions = rolePermissions(role)): PageId[] {
  const selection = role.pages?.length ? new Set(role.pages) : null;
  return ALL_PAGES.filter(id => permissions.includes(`${PAGES[id].module}.view`) && (!selection || selection.has(id)));
}

export const isSuperAdmin = (u: PortalUser | null | undefined) => Boolean(u && u.role === "healjour_admin" && u.isSuperAdmin);

export async function listAdminRoles(): Promise<AdminRole[]> {
  const custom = await getStore().docList<AdminRole>(ROLES_COLLECTION);
  return [FULL_ACCESS, ...custom.map(r => ({ ...r, permissions: rolePermissions(r) })).sort((a, b) => a.name.localeCompare(b.name))];
}

/** A workspace-scoped admin works inside tenants only: platform-wide pages are never theirs, whatever the role says. */
export const isWorkspaceScoped = (u: PortalUser) => u.role === "healjour_admin" && !isSuperAdmin(u) && Boolean(u.workspaceIds?.length);

export async function allowedAdminAccess(u: PortalUser): Promise<{ permissions: PermissionId[]; pages: PageId[] }> {
  if (u.role !== "healjour_admin" || isSuperAdmin(u)) return { permissions: ALL_PERMISSIONS, pages: ALL_PAGES };
  let access: { permissions: PermissionId[]; pages: PageId[] };
  if (!u.adminRoleId || u.adminRoleId === FULL_ACCESS.id) access = { permissions: ALL_PERMISSIONS, pages: ALL_PAGES };
  else {
    const role = await getStore().docGet<AdminRole>(ROLES_COLLECTION, u.adminRoleId);
    if (!role) return { permissions: [], pages: [] };
    const permissions = rolePermissions(role);
    access = { permissions, pages: rolePages(role, permissions) };
  }
  return isWorkspaceScoped(u) ? { ...access, pages: access.pages.filter(id => WORKSPACE_PAGES.includes(id)) } : access;
}

/** Every permission a user has. Super Admins and lab users are not limited here. */
export const allowedPermissions = async (u: PortalUser) => (await allowedAdminAccess(u)).permissions;
export const allowedPages = async (u: PortalUser) => (await allowedAdminAccess(u)).pages;

/** Modules a user can open (has ".view"). */
export const viewableModules = (permissions: PermissionId[]) => ALL_MODULES.filter(m => permissions.includes(`${m}.view`));
export const allowedModules = async (u: PortalUser) => viewableModules((await allowedAdminAccess(u)).permissions);

// Match the case-insensitive, non-strict paths used by Express.
export const normalizeApiPath = (path: string) => path.toLowerCase().replace(/\/+$/, "");
const starts = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
const reads = (method: string) => method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD";

const CONNECTION_READERS: readonly PageId[] = [
  "test-catalog", "corporate-mapping", "test-builder", "organizations", "orders-bookings",
  "integrations", "connector-marketplace", "api-webhooks", "monitoring-sla", "settings"
];
const CONNECTION_TOOLS: Readonly<Record<string, readonly PageId[]>> = {
  "ai-match": ["test-builder"],
  corporates: ["test-catalog", "corporate-mapping", "orders-bookings"],
  "corporate-mappings": ["test-catalog", "corporate-mapping"],
  "flabs-catalog": ["orders-bookings"],
  mappings: ["test-catalog", "test-builder", "orders-bookings"],
  "prebooking-settings": ["orders-bookings"],
  sync: ["test-catalog", "orders-bookings"],
  webhooks: ["test-catalog"]
};

/** Pages that consume a request. Shared requests can be used by any of their listed pages. */
export function pagesForPath(method: string, requestPath: string): readonly PageId[] {
  const path = normalizeApiPath(requestPath);
  if (method.toUpperCase() === "POST" && ["/api/integrations", "/api/integrations/test", "/api/integrations/validate"].includes(path)) {
    return ["integration-studio"];
  }
  if (path === "/api/flabs/bookings" && reads(method)) return ["booking-tracker"];
  if (path === "/api/core/topology" && reads(method)) return ["core-layers", "integrations", "connector-marketplace"];
  if (path === "/api/portal/labs" && reads(method)) return ["labs-users", "lab-cases"];
  if (path === "/api/catalog" && reads(method)) return ["test-catalog", "test-builder"];
  if (path === "/api/portal/notifications" && reads(method)) return ["lab-cases", "results-smart-reports"];
  if (path === "/api/catalog/tests" && method.toUpperCase() === "POST") return ["test-catalog", "orders-bookings"];

  if (starts(path, "/api/flabs/connections")) {
    if (path === "/api/flabs/connections" && reads(method)) return CONNECTION_READERS;
    const tool = path.split("/")[5];
    return tool && Object.hasOwn(CONNECTION_TOOLS, tool) ? CONNECTION_TOOLS[tool] : ["test-catalog"];
  }

  const match = PAGE_API_PREFIXES.find(({ prefix }) => starts(path, prefix));
  return match ? [match.id] : [];
}

/** The exclusive owner of an API path, if it has one. */
export function pageForPath(method: string, path: string): PageId | null {
  const pages = pagesForPath(method, path);
  return pages.length === 1 ? pages[0] : null;
}

/** Existing module actions still apply to shared routes alongside page access. */
export function moduleForPath(method: string, requestPath: string, pages = pagesForPath(method, requestPath)): ModuleId | null {
  const path = normalizeApiPath(requestPath);
  if (path === "/api/portal/notifications") return null; // The response is scoped to each available page.
  if (starts(path, "/api/flabs/connections")) {
    // Booking forms and account-management pages use the same account data.
    return reads(method) ? null : "catalog";
  }
  return pages.length ? PAGES[pages[0]].module : null;
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

export function permissionForRequest(method: string, path: string, query: Record<string, unknown> = {}, pages = pagesForPath(method, path)): PermissionId | null {
  const mod = moduleForPath(method, path, pages);
  return mod ? `${mod}.${actionForRequest(method, normalizeApiPath(path), query)}` : null;
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
