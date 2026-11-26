import { useEffect, useMemo, useState } from "react";
import { cn } from "cn";
import { Eye, KeyRound, LogOut, Plus, RefreshCw, Save, Search, ShieldCheck, Trash2, UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PortalUser } from "../portal/api";
import { CreatedBy, WorkspaceTag, type CreatorData, type WorkspaceTagData } from "../lib/record-tags";

type Modules = Record<string, { label: string; description: string }>;
type Role = { id: string; name: string };
type Admin = PortalUser & { roleName: string; activeSessions: number; effectivePages: string[]; creator: CreatorData };
type AdminPages = Record<string, { label: string; section: string }>;
type WorkspaceOption = { id: string; tenantId: string; code: string; name: string; active: boolean };
type AdminList = { admins: Admin[]; roles: Role[]; pages: AdminPages; workspaces: WorkspaceOption[] };
type User = PortalUser & { labName: string | null; creator: CreatorData; workspaces: NonNullable<WorkspaceTagData>[] };

/** "Login as": asks for a reason, then opens the user's account in this browser (audited, 1 hour). */
export async function loginAs(user: { id: string; name: string; email: string }) {
  const reason = window.prompt(`Log in as ${user.name} (${user.email})?\n\nYou will see exactly what they see for up to 1 hour. Everything you do is recorded with both your names. Your own Super Admin session ends; use "Return to Super Admin" to come back.\n\nReason (required):`, "");
  if (reason === null) return null;
  const d = await call<{ redirect: string }>(`/api/super/users/${user.id}/impersonate`, "POST", { reason });
  window.location.href = d.redirect;
  return `Opening ${user.name}'s account…`;
}
type Session = { id: string; createdAt: string; expiresAt: string; userAgent: string; current: boolean; user: { id: string; name: string; email: string; role: string; isSuperAdmin: boolean } | null };
type AuditEvent = { seq: number; at: string; actor: string; action: string; detail: string };
type Overview = { counts: Record<string, number>; auditChain: { intact: boolean; brokenAt?: number }; recentAudit: AuditEvent[]; modules: Modules };

export const when = (iso?: string) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const ROLE_TEXT: Record<string, string> = { healjour_admin: "Healjour admin", lab_admin: "Lab admin", lab_staff: "Lab staff", lab_viewer: "Lab viewer" };
const browser = (ua: string) => (/Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : ua ? "Other" : "—") + (/Windows/.test(ua) ? " · Windows" : /Android/.test(ua) ? " · Android" : /iPhone|iPad/.test(ua) ? " · iOS" : /Mac OS/.test(ua) ? " · macOS" : "");

export async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status}).`);
  return data as T;
}

export type Run = (task: () => Promise<string>) => Promise<void>;

export function OverviewTab() {
  const [d, setD] = useState<Overview | null>(null);
  useEffect(() => { void call<Overview>("/api/super/overview").then(setD).catch(() => undefined); }, []);
  if (!d) return <p className="sa-muted">Loading…</p>;
  const c = d.counts;
  return <div className="sa-stack">
    <div className="sa-stats">
      {([["Admins", c.admins], ["Super Admins", c.superAdmins], ["Labs (active)", `${c.labs} (${c.activeLabs})`], ["Lab users", c.labUsers], ["Disabled users", c.disabledUsers], ["Signed in now", c.activeSessions], ["Admin roles", c.roles]] as Array<[string, string | number]>)
        .map(([l, v]) => <div key={l}><small>{l}</small><b>{v}</b></div>)}
    </div>
    <section className="access-card">
      <div className="access-card-head"><div><h2>Audit trail</h2><p>Each entry is chained to the one before it, so editing or deleting history is detectable.</p></div>
        <span className={`sa-pill ${d.auditChain.intact ? "ok" : "bad"}`}>{d.auditChain.intact ? "Chain intact" : `Broken at #${d.auditChain.brokenAt}`}</span></div>
      <AuditList events={d.recentAudit} />
    </section>
    <section className="access-card">
      <div className="access-card-head"><div><h2>Modules</h2><p>Parts of the product an admin role can include.</p></div></div>
      <div className="sa-modules">{Object.entries(d.modules).map(([id, m]) => <div key={id}><b>{m.label}</b><small>{m.description}</small></div>)}</div>
    </section>
  </div>;
}

export function AdminsTab({ me, run, setSecret }: { me: PortalUser; run: Run; setSecret: (s: { email: string; password: string }) => void }) {
  const [{ admins, roles, pages, workspaces }, setList] = useState<AdminList>({ admins: [], roles: [], pages: {}, workspaces: [] });
  const [form, setForm] = useState<{ name: string; email: string; adminRoleId: string; isSuperAdmin: boolean; workspaceIds: string[] } | null>(null);
  const load = () => call<AdminList>("/api/super/admins").then(setList);
  useEffect(() => { void load().catch(() => undefined); }, []);
  const act = (task: () => Promise<string>) => run(async () => { const m = await task(); await load(); return m; });
  const create = () => form && act(async () => {
    const d = await call<{ user: PortalUser; temporaryPassword: string }>("/api/super/admins", "POST", form);
    setSecret({ email: d.user.email, password: d.temporaryPassword }); setForm(null);
    return `${d.user.name} added.`;
  });
  const update = (a: Admin, body: Record<string, unknown>, msg: string) => act(async () => { await call(`/api/super/admins/${a.id}`, "PUT", body); return msg; });
  const reset = (a: Admin) => act(async () => { const d = await call<{ temporaryPassword: string }>(`/api/super/admins/${a.id}/reset-password`, "POST", {}); setSecret({ email: a.email, password: d.temporaryPassword }); return `Password reset for ${a.name}; their sessions were ended.`; });
  const signOut = (a: Admin) => act(async () => { await call(`/api/super/users/${a.id}/sign-out`, "POST", {}); return `${a.name} was signed out everywhere.`; });

  return <section className="access-card">
    <div className="access-card-head"><div><h2>Healjour admins</h2><p>Each admin gets a role (which pages and actions) and workspace access (which tenants' data). Super Admins can use every page, every workspace and this console.</p></div>
      {!form && <Button variant="default" onClick={() => setForm({ name: "", email: "", adminRoleId: "full-access", isSuperAdmin: false, workspaceIds: [] })}><UserPlus size={15} /> Add admin</Button>}</div>
    {form && <div className="form-grid sa-form">
      <label className="field"><span>Name</span><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
      <label className="field"><span>Email</span><input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></label>
      <label className="field"><span>Admin role</span><select value={form.adminRoleId} disabled={form.isSuperAdmin} onChange={e => setForm({ ...form, adminRoleId: e.target.value })}>{roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <label className="sa-check"><input type="checkbox" checked={form.isSuperAdmin} onChange={e => setForm({ ...form, isSuperAdmin: e.target.checked })} /> Super Admin (full control)</label>
      {!form.isSuperAdmin && <div className="field ws-wide"><span>Workspace access</span>
        <WorkspacePicker workspaces={workspaces} value={form.workspaceIds} onChange={ids => setForm({ ...form, workspaceIds: ids })} />
      </div>}
      <div className="builder-actions"><Button variant="default" disabled={form.name.trim().length < 2 || !form.email.includes("@")} onClick={() => void create()}>Create admin</Button><Button variant="outline" onClick={() => setForm(null)}>Cancel</Button></div>
    </div>}
    <div className="sa-table-wrap"><table className="sa-table">
      <thead><tr><th>Admin</th><th>Access</th><th>Status</th><th>Last sign-in</th><th>Sessions</th><th>Actions</th></tr></thead>
      <tbody>{admins.map(a => {
        const self = a.id === me.id;
        const roleId = a.adminRoleId ?? "full-access";
        return <tr key={a.id}>
          <td><b>{a.name}{self && <small> (you)</small>}</b><small>{a.email}</small><small className="id-line">ID {a.id}</small><CreatedBy creator={a.creator} at={a.createdAt} /></td>
          <td>
            {a.isSuperAdmin ? <span className="sa-pill super">Super Admin</span>
              : <select aria-label={`Admin role for ${a.name}`} value={roleId} onChange={e => void update(a, { adminRoleId: e.target.value }, `${a.name}'s role changed.`)}>
                {!roles.some(r => r.id === roleId) && <option value={roleId} disabled>{a.roleName}</option>}
                {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>}
            {!a.isSuperAdmin && <WorkspaceAccess admin={a} workspaces={workspaces}
              onSave={ids => void update(a, { workspaceIds: ids }, ids.length ? `${a.name} now works in ${ids.length} workspace(s).` : `${a.name} is now a platform admin (all workspaces).`)} />}
            <AdminPageAccess effectivePages={a.effectivePages} pages={pages} />
          </td>
          <td><span className={`sa-pill ${a.active ? "ok" : "bad"}`}>{a.active ? "Active" : "Disabled"}</span>{a.mustChangePassword && <small>must set password</small>}</td>
          <td>{when(a.lastLoginAt)}</td>
          <td>{a.activeSessions}</td>
          <td className="sa-actions">{!self && <>
            {!a.isSuperAdmin && a.active && <Button variant="default" size="sm" title="Open this admin's account to see what they see" onClick={() => void run(async () => (await loginAs(a)) ?? "")}><Eye size={13} /> Login as</Button>}
            <Button variant="outline" size="sm" onClick={() => void update(a, { isSuperAdmin: !a.isSuperAdmin }, a.isSuperAdmin ? `${a.name} is no longer a Super Admin.` : `${a.name} is now a Super Admin.`)}>{a.isSuperAdmin ? "Remove Super" : "Make Super"}</Button>
            <Button variant="outline" size="sm" onClick={() => void reset(a)}><KeyRound size={13} /> Reset</Button>
            <Button variant="outline" size="sm" disabled={!a.activeSessions} onClick={() => void signOut(a)}><LogOut size={13} /> Sign out</Button>
            <Button variant={a.active ? "destructive" : "outline"} size="sm" onClick={() => void update(a, { active: !a.active }, a.active ? `${a.name} disabled.` : `${a.name} enabled.`)}>{a.active ? "Disable" : "Enable"}</Button>
          </>}</td>
        </tr>;
      })}</tbody>
    </table></div>
  </section>;
}

/** No workspace ticked = platform admin (every workspace plus platform pages). Ticking any limits them to those tenants. */
function WorkspacePicker({ workspaces, value, onChange }: { workspaces: WorkspaceOption[]; value: string[]; onChange: (ids: string[]) => void }) {
  if (!workspaces.length) return <small className="sa-muted">No workspaces yet: this admin works across all labs. Create workspaces in Workspaces.</small>;
  return <div className="ws-choices">
    <label className={`ws-choice${value.length === 0 ? " on" : ""}`}><input type="radio" checked={value.length === 0} onChange={() => onChange([])} /> All workspaces <small>platform admin</small></label>
    {workspaces.map(w => <label key={w.id} className={`ws-choice${value.includes(w.id) ? " on" : ""}`}>
      <input type="checkbox" checked={value.includes(w.id)} onChange={() => onChange(value.includes(w.id) ? value.filter(x => x !== w.id) : [...value, w.id])} />
      {w.name} <small>{w.tenantId}{!w.active && " · paused"}</small>
    </label>)}
  </div>;
}

function WorkspaceAccess({ admin, workspaces, onSave }: { admin: Admin; workspaces: WorkspaceOption[]; onSave: (ids: string[]) => void }) {
  const [editing, setEditing] = useState<string[] | null>(null);
  const ids = admin.workspaceIds ?? [];
  if (editing) return <div className="ws-edit">
    <WorkspacePicker workspaces={workspaces} value={editing} onChange={setEditing} />
    <div className="builder-actions"><Button variant="default" size="sm" onClick={() => { onSave(editing); setEditing(null); }}><Save size={13} /> Save</Button><Button variant="outline" size="sm" onClick={() => setEditing(null)}>Cancel</Button></div>
  </div>;
  return <div className="ws-line">
    {ids.length === 0 ? <span className="su-chip all">All workspaces</span>
      : ids.map(id => <span key={id} className="su-chip">{workspaces.find(w => w.id === id)?.name ?? "Deleted workspace"}</span>)}
    {workspaces.length > 0 && <button type="button" className="ws-edit-link" onClick={() => setEditing(ids)}>Change</button>}
  </div>;
}

function AdminPageAccess({ effectivePages, pages }: { effectivePages: string[]; pages: AdminPages }) {
  const allowed = new Set(effectivePages);
  const groups = new Map<string, Array<{ id: string; label: string }>>();
  const registered = Object.entries(pages);
  for (const [id, { label, section }] of registered) {
    if (!allowed.has(id)) continue;
    const group = groups.get(section) ?? [];
    group.push({ id, label });
    groups.set(section, group);
  }

  return <div className="mt-1.5">
    {groups.size === 0 ? <span className="su-chip">Overview only</span>
      : registered.every(([id]) => allowed.has(id)) ? <span className="su-chip all">All admin pages</span>
      : Array.from(groups, ([section, group]) => <div key={section}>
        <small>{section}</small>
        <div className="flex flex-wrap">{group.map(({ id, label }) => <span key={id} className="su-chip whitespace-nowrap">{label}</span>)}</div>
      </div>)}
  </div>;
}


export function UsersTab({ me, run }: { me: PortalUser; run: Run }) {
  const [users, setUsers] = useState<User[]>([]);
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const load = () => call<{ users: User[] }>("/api/super/users").then(d => setUsers(d.users)).catch(() => undefined);
  useEffect(() => { void load(); }, []);
  const shown = useMemo(() => users.filter(u => (!roleFilter || u.role === roleFilter) && (!q || `${u.name} ${u.email} ${u.labName ?? ""}`.toLowerCase().includes(q.toLowerCase()))), [users, q, roleFilter]);
  const toggle = (u: User) => run(async () => { await call(`/api/super/users/${u.id}`, "PUT", { active: !u.active }); await load(); return `${u.name} ${u.active ? "disabled and signed out" : "enabled"}.`; });
  const signOut = (u: User) => run(async () => { await call(`/api/super/users/${u.id}/sign-out`, "POST", {}); return `${u.name} signed out everywhere.`; });
  return <section className="access-card">
    <div className="access-card-head"><div><h2>Every user</h2><p>Healjour admins and every lab's users. Disabling someone signs them out at once.</p></div></div>
    <div className="sa-filters">
      <label className="corp-search"><Search size={14} /><input placeholder="Search name, email or lab" value={q} onChange={e => setQ(e.target.value)} /></label>
      <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)}><option value="">All roles</option>{Object.entries(ROLE_TEXT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <span className="sa-muted">{shown.length} of {users.length}</span>
    </div>
    <div className="sa-table-wrap"><table className="sa-table">
      <thead><tr><th>User</th><th>Role</th><th>Lab · workspace</th><th>Status</th><th>Last sign-in</th><th>Actions</th></tr></thead>
      <tbody>{shown.map(u => <tr key={u.id}>
        <td><b>{u.name}{u.id === me.id && <small> (you)</small>}</b><small>{u.email}</small><small className="id-line">ID {u.id}</small><CreatedBy creator={u.creator} at={u.createdAt} /></td>
        <td>{u.isSuperAdmin ? <span className="sa-pill super">Super Admin</span> : ROLE_TEXT[u.role] ?? u.role}</td>
        <td>{u.labName ?? "—"}<div>{u.workspaces.length ? u.workspaces.map(w => <WorkspaceTag key={w.id} workspace={w} />) : u.role === "healjour_admin" && !u.isSuperAdmin ? <span className="su-chip all">All workspaces</span> : null}</div></td>
        <td><span className={`sa-pill ${u.active ? "ok" : "bad"}`}>{u.active ? "Active" : "Disabled"}</span></td>
        <td>{when(u.lastLoginAt)}</td>
        <td className="sa-actions">{u.id !== me.id && <>
          {!u.isSuperAdmin && u.active && <Button variant="default" size="sm" title="Open this user's account to see what they see" onClick={() => void run(async () => (await loginAs(u)) ?? "")}><Eye size={13} /> Login as</Button>}
          <Button variant="outline" size="sm" onClick={() => void signOut(u)}><LogOut size={13} /> Sign out</Button>
          <Button variant={u.active ? "destructive" : "outline"} size="sm" onClick={() => void toggle(u)}>{u.active ? "Disable" : "Enable"}</Button>
        </>}</td>
      </tr>)}</tbody>
    </table></div>
  </section>;
}

export function SessionsTab({ run }: { run: Run }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const load = () => call<{ sessions: Session[] }>("/api/super/sessions").then(d => setSessions(d.sessions)).catch(() => undefined);
  useEffect(() => { void load(); }, []);
  const revoke = (s: Session) => run(async () => { await call(`/api/super/sessions/${s.id}`, "DELETE"); await load(); return "Session ended."; });
  return <section className="access-card">
    <div className="access-card-head"><div><h2>Signed in now</h2><p>Every live session (12-hour limit). End one to sign that device out.</p></div>
      <Button variant="outline" onClick={() => void load()}><RefreshCw size={14} /> Refresh</Button></div>
    <div className="sa-table-wrap"><table className="sa-table">
      <thead><tr><th>User</th><th>Device</th><th>Signed in</th><th>Expires</th><th /></tr></thead>
      <tbody>{sessions.map(s => <tr key={s.id}>
        <td><b>{s.user?.name ?? "Deleted user"}{s.current && <small> (this browser)</small>}</b><small>{s.user?.email} · {s.user?.isSuperAdmin ? "Super Admin" : ROLE_TEXT[s.user?.role ?? ""] ?? ""}</small></td>
        <td>{browser(s.userAgent)}</td><td>{when(s.createdAt)}</td><td>{when(s.expiresAt)}</td>
        <td>{!s.current && <Button variant="destructive" size="sm" onClick={() => void revoke(s)}>End session</Button>}</td>
      </tr>)}</tbody>
    </table></div>
  </section>;
}

export function AuditTab() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [chain, setChain] = useState<{ intact: boolean; brokenAt?: number } | null>(null);
  const [q, setQ] = useState("");
  const load = (query = q) => call<{ events: AuditEvent[]; chain: { intact: boolean; brokenAt?: number } }>(`/api/super/audit?limit=500&q=${encodeURIComponent(query)}`).then(d => { setEvents(d.events); setChain(d.chain); }).catch(() => undefined);
  useEffect(() => { void load(""); }, []);
  const exportCsv = () => {
    const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = ["seq,at,actor,action,detail", ...events.map(e => [e.seq, e.at, e.actor, e.action, e.detail].map(cell).join(","))].join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" })); a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
  return <section className="access-card">
    <div className="access-card-head"><div><h2>Audit log</h2><p>Who did what and when: sign-ins, user and role changes, consent, data requests, lab updates.</p></div>
      {chain && <span className={`sa-pill ${chain.intact ? "ok" : "bad"}`}>{chain.intact ? "Chain intact" : `Broken at #${chain.brokenAt}`}</span>}</div>
    <div className="sa-filters">
      <label className="corp-search"><Search size={14} /><input placeholder="Search actor, action or detail" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void load(); }} /></label>
      <Button variant="outline" size="sm" onClick={() => void load()}>Search</Button>
      <Button variant="outline" size="sm" disabled={!events.length} onClick={exportCsv}>Export CSV</Button>
    </div>
    <AuditList events={events} />
  </section>;
}

export function AuditList({ events }: { events: AuditEvent[] }) {
  if (!events.length) return <p className="sa-muted">No entries.</p>;
  return <ul className="sa-audit">{events.map(e => <li key={e.seq}>
    <span className="sa-seq">#{e.seq}</span>
    <span><b>{e.action}</b> <small>{e.actor}</small><p>{e.detail}</p></span>
    <time>{when(e.at)}</time>
  </li>)}</ul>;
}
