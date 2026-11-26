// Multi-tenancy: a workspace (tenant) owns partner labs and Flabs accounts, and through them their cases,
// bookings, results and logs. Each lab and each account belongs to at most one workspace.
//
// Platform admin     Healjour admin without workspaceIds (and every Super Admin). Sees every workspace and the
//                    platform pages; may narrow the view to one workspace with the switcher (cookie hj_ws).
// Workspace admin    Healjour admin with workspaceIds. Sees only those workspaces' data and only workspace pages.
//                    Resources that belong to no workspace are visible to platform admins only.
// Lab users are scoped by their own labId elsewhere; this file does not limit them.

import type { Request, Response } from "express";
import { getStore } from "../store.js";
import { allFlabsConfigs, getFlabsConfig } from "../flabs/connection.js";
import { currentUser, LABS, readCookie, type PortalLab, type PortalUser } from "./auth.js";
import type { Actor } from "./actor.js";

export type Workspace = {
  id: string;
  tenantId: string;              // human-readable, unique and permanent: HJT-000001, HJT-000002, …
  code: string; name: string; description: string;
  labIds: string[]; connectionIds: string[];
  active: boolean; createdAt: string; updatedAt: string;
  creator?: Actor; updater?: Actor;
};
export const WORKSPACES = "workspaces";
export const WORKSPACE_COOKIE = "hj_ws";

/** Next tenant ID. The counter only moves forward, so a deleted workspace's ID is never reused. */
export async function nextTenantId(): Promise<string> {
  const store = getStore();
  const counter = await store.docGet<{ id: string; value: number }>("counters", "tenant");
  const existing = (await store.docList<Workspace>(WORKSPACES)).map(w => Number(w.tenantId?.replace(/\D/g, "")) || 0);
  const value = Math.max(counter?.value ?? 0, ...existing, 0) + 1;
  await store.docPut("counters", { id: "tenant", value });
  return `HJT-${String(value).padStart(6, "0")}`;
}

/** Which workspace a lab, Flabs account or booking/log account name belongs to, for tagging rows. */
export type WorkspaceTag = { id: string; tenantId: string; name: string };
export async function workspaceTagger() {
  const workspaces = await listWorkspaces();
  const labs = await getStore().docList<PortalLab>(LABS);
  const tag = (w: Workspace): WorkspaceTag => ({ id: w.id, tenantId: w.tenantId, name: w.name });
  const byLab = new Map<string, WorkspaceTag>(), byConn = new Map<string, WorkspaceTag>(), byAccount = new Map<string, WorkspaceTag>(), byId = new Map<string, WorkspaceTag>();
  const configs = allFlabsConfigs();
  for (const w of workspaces) {
    const t = tag(w);
    byId.set(w.id, t);
    for (const id of w.labIds) { byLab.set(id, t); const lab = labs.find(l => l.id === id); if (lab) byAccount.set(lab.name, t); }
    for (const id of w.connectionIds) { byConn.set(id, t); const c = configs.find(x => x.id === id); if (c) byAccount.set(c.label, t); }
  }
  return {
    lab: (id?: string | null) => (id && byLab.get(id)) || null,
    connection: (id?: string | null) => (id && byConn.get(id)) || null,
    account: (name?: string | null) => (name && byAccount.get(name)) || null,
    workspace: (id?: string | null) => (id && byId.get(id)) || null
  };
}

export type DataScope = {
  all: boolean;                  // true: no filter (platform admin with no workspace selected, or a lab user)
  workspaces: Workspace[];       // the workspaces this view covers
  labIds: Set<string>;
  connectionIds: Set<string>;
  accounts: Set<string>;         // Flabs account labels and lab names, as written on bookings, results and logs
};

declare module "express-serve-static-core" {
  interface Request { dataScope?: DataScope }
}

const UNSCOPED: DataScope = { all: true, workspaces: [], labIds: new Set(), connectionIds: new Set(), accounts: new Set() };

export async function listWorkspaces(): Promise<Workspace[]> {
  const all = await getStore().docList<Workspace>(WORKSPACES);
  // Workspaces made before tenant IDs existed get one, oldest first.
  for (const w of all.filter(x => !x.tenantId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    w.tenantId = await nextTenantId();
    await getStore().docPut(WORKSPACES, w);
  }
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

const isPlatformAdmin = (u: PortalUser) => u.role === "healjour_admin" && (Boolean(u.isSuperAdmin) || !u.workspaceIds?.length);

/** Active workspaces this admin may enter. */
export async function memberWorkspaces(u: PortalUser): Promise<Workspace[]> {
  const active = (await listWorkspaces()).filter(w => w.active);
  return isPlatformAdmin(u) ? active : active.filter(w => u.workspaceIds!.includes(w.id));
}

export async function scopeFor(u: PortalUser, selectedId?: string | null): Promise<DataScope> {
  if (u.role !== "healjour_admin") return UNSCOPED;
  const mine = await memberWorkspaces(u);
  const selected = selectedId ? mine.find(w => w.id === selectedId) : undefined;
  if (isPlatformAdmin(u) && !selected) return { ...UNSCOPED, workspaces: mine };
  const workspaces = selected ? [selected] : mine;
  const labIds = new Set(workspaces.flatMap(w => w.labIds));
  const connectionIds = new Set(workspaces.flatMap(w => w.connectionIds));
  const labs = await getStore().docList<PortalLab>(LABS);
  const accounts = new Set([
    ...allFlabsConfigs().filter(c => connectionIds.has(c.id)).map(c => c.label),
    ...labs.filter(l => labIds.has(l.id)).map(l => l.name)
  ]);
  return { all: false, workspaces, labIds, connectionIds, accounts };
}

/** The data scope of this request, computed once. */
export async function requestScope(req: Request): Promise<DataScope> {
  if (req.dataScope) return req.dataScope;
  const user = req.portalUser ?? await currentUser(req);
  req.dataScope = user ? await scopeFor(user, readCookie(req, WORKSPACE_COOKIE)) : UNSCOPED;
  return req.dataScope;
}

export const canSeeLab = (s: DataScope, labId?: string | null) => s.all || Boolean(labId && s.labIds.has(labId));
export const canSeeConnection = (s: DataScope, id?: string | null) => s.all || Boolean(id && s.connectionIds.has(id));
export const canSeeAccount = (s: DataScope, account?: string | null) => s.all || Boolean(account && s.accounts.has(account));

/** The workspace new labs and accounts go into: the only one in view. null = platform view (no workspace). */
export function targetWorkspace(s: DataScope): Workspace | null | "ambiguous" {
  if (s.all) return null;
  return s.workspaces.length === 1 ? s.workspaces[0] : "ambiguous";
}

export async function addToWorkspace(workspace: Workspace, kind: "labIds" | "connectionIds", id: string) {
  const fresh = await getStore().docGet<Workspace>(WORKSPACES, workspace.id);
  if (!fresh || fresh[kind].includes(id)) return;
  await getStore().docPut(WORKSPACES, { ...fresh, [kind]: [...fresh[kind], id], updatedAt: new Date().toISOString() });
}

/** Removes a deleted lab or account from whichever workspace held it. */
export async function removeFromWorkspaces(kind: "labIds" | "connectionIds", id: string) {
  for (const w of await listWorkspaces()) {
    if (w[kind].includes(id)) await getStore().docPut(WORKSPACES, { ...w, [kind]: w[kind].filter(x => x !== id), updatedAt: new Date().toISOString() });
  }
}

/** The Flabs account a booking call targets: the chosen one, or the default account when none is given. */
export const bookingConnectionId = (id: unknown) => (typeof id === "string" && id ? id : getFlabsConfig()?.id);

export function setWorkspaceCookie(req: Request, res: Response, workspaceId: string | null) {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  const cookie = workspaceId
    ? `${WORKSPACE_COOKIE}=${encodeURIComponent(workspaceId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secure ? "; Secure" : ""}`
    : `${WORKSPACE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  res.append("Set-Cookie", cookie);
}
