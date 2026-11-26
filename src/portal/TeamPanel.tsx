import { useEffect, useState } from "react";
import { Copy, KeyRound, Search, UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, fmtDate, ROLE_LABEL, type PortalLab, type PortalUser, type Role } from "./api";
import { CreatedBy } from "../lib/record-tags";

type Tab = "all" | "active" | "invited" | "disabled";

const statusOf = (u: PortalUser): "active" | "invited" | "disabled" => (!u.active ? "disabled" : u.mustChangePassword ? "invited" : "active");
const STATUS_TEXT = { active: "Active", invited: "Invited", disabled: "Disabled" } as const;
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase();

/**
 * Users of one lab (or Healjour admins when lab is null). Lab admins manage staff and viewers of their own lab;
 * Healjour admins manage everyone. New users get a one-time password shown once.
 */
export function TeamPanel({ me, lab }: { me: PortalUser; lab: PortalLab | null }) {
  const [users, setUsers] = useState<PortalUser[]>([]);
  const [form, setForm] = useState<{ name: string; email: string; role: Role } | null>(null);
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<"" | Role>("");
  const isHealjour = me.role === "healjour_admin";
  const roleChoices: Role[] = lab ? (isHealjour ? ["lab_admin", "lab_staff", "lab_viewer"] : ["lab_staff", "lab_viewer"]) : ["healjour_admin"];

  const load = async () => {
    try {
      const data = await api<{ users: PortalUser[] }>(`/api/portal/users${isHealjour ? `?labId=${encodeURIComponent(lab?.id ?? "")}` : ""}`);
      setUsers(lab ? data.users : data.users.filter(u => !u.labId));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load users."); }
  };
  useEffect(() => { setSecret(null); setForm(null); setTab("all"); setQuery(""); setRoleFilter(""); void load(); }, [lab?.id]);

  const run = async (task: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await task(); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Something went wrong."); } finally { setBusy(false); }
  };
  const add = () => run(async () => {
    if (!form) return;
    const data = await api<{ temporaryPassword: string; user: PortalUser }>("/api/portal/users", { body: { ...form, labId: lab?.id ?? null } });
    setSecret({ email: data.user.email, password: data.temporaryPassword });
    setForm(null);
  });
  const manageable = (u: PortalUser) => isHealjour || u.role === "lab_staff" || u.role === "lab_viewer";

  const counts = {
    all: users.length,
    active: users.filter(u => statusOf(u) === "active").length,
    invited: users.filter(u => statusOf(u) === "invited").length,
    disabled: users.filter(u => statusOf(u) === "disabled").length
  };
  const q = query.trim().toLowerCase();
  const shown = users
    .filter(u => tab === "all" || statusOf(u) === tab)
    .filter(u => !roleFilter || u.role === roleFilter)
    .filter(u => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));

  const TABS: Array<[Tab, string]> = [["all", "All"], ["active", "Active"], ["invited", "Invited"], ["disabled", "Disabled"]];

  return <section className="team-card">
    <div className="team-head">
      <div>
        <h2>{lab ? `${lab.name}: team` : "Healjour admins"}</h2>
        <p>{lab ? "Each person signs in with their own email. Roles decide what they can do." : "People who manage every lab."}</p>
      </div>
      {!form && <Button variant="default" onClick={() => setForm({ name: "", email: "", role: roleChoices[roleChoices.length > 1 ? 1 : 0] })}><UserPlus size={15} /> Add user</Button>}
    </div>

    <div className="team-tabs" role="tablist">
      {TABS.map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? "on" : ""} onClick={() => setTab(value)}>
        {label} <span className="team-count">{counts[value]}</span>
      </button>)}
    </div>

    <div className="team-toolbar">
      <label className="team-search"><Search size={14} /><input placeholder={`Search ${lab ? "staff" : "admins"} by name or email`} value={query} onChange={e => setQuery(e.target.value)} /></label>
      <select value={roleFilter} onChange={e => setRoleFilter(e.target.value as "" | Role)} aria-label="Filter by role">
        <option value="">All roles</option>
        {roleChoices.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
      </select>
    </div>

    <div className="role-guide">
      {(lab ? (["lab_admin", "lab_staff", "lab_viewer"] as Role[]) : (["healjour_admin"] as Role[])).map(r => <div key={r}><b>{ROLE_LABEL[r]}</b><small>{
        r === "lab_admin" ? "Cases, reports, and adds staff/viewers" :
        r === "lab_staff" ? "Updates status, results and reports" :
        r === "lab_viewer" ? "Reads cases and downloads reports" : "Every lab, every case, all settings"}</small></div>)}
    </div>

    {secret && <div className="secret-box">
      <b>One-time password for {secret.email}</b>
      <code>{secret.password}</code>
      <small>Share it privately. It is shown only now; they must set their own password at first sign-in.</small>
      <div className="builder-actions">
        <Button variant="outline" size="sm" onClick={() => void navigator.clipboard?.writeText(secret.password)}><Copy size={13} /> Copy</Button>
        <Button variant="outline" size="sm" onClick={() => setSecret(null)}>Done</Button>
      </div>
    </div>}

    {form && <div className="form-grid team-form">
      <label className="field"><span>Name *</span><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
      <label className="field"><span>Email *</span><input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></label>
      <label className="field"><span>Role *</span><select value={form.role} onChange={e => setForm({ ...form, role: e.target.value as Role })}>{roleChoices.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></label>
      <div className="builder-actions" style={{ alignSelf: "end" }}>
        <Button variant="default" disabled={busy || form.name.trim().length < 2 || !form.email.includes("@")} onClick={() => void add()}>Create user</Button>
        <Button variant="outline" onClick={() => setForm(null)}>Cancel</Button>
      </div>
    </div>}
    {error && <div className="access-message error"><X size={16} />{error}</div>}

    <div className="team-table-wrap">
      <table className="team-table">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last sign-in</th><th className="team-actions-th">Actions</th></tr></thead>
        <tbody>
          {shown.map(u => {
            const st = statusOf(u);
            return <tr key={u.id}>
              <td><span className="team-person">
                <span className={`team-avatar ${st}`}>{initials(u.name)}</span>
                <span><b>{u.name}</b>{u.id === me.id && <small> (you)</small>}<CreatedBy creator={u.creator} /></span>
              </span></td>
              <td className="team-email">{u.email}</td>
              <td>{manageable(u) && u.id !== me.id ? <select className="team-role-select" value={u.role} onChange={e => void run(async () => { await api(`/api/portal/users/${u.id}`, { method: "PUT", body: { role: e.target.value } }); })}>
                {roleChoices.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select> : <span className="team-role">{ROLE_LABEL[u.role]}</span>}</td>
              <td><span className={`team-status ${st}`}><i />{STATUS_TEXT[st]}</span></td>
              <td className="team-muted">{fmtDate(u.lastLoginAt)}</td>
              <td className="team-actions-td">{manageable(u) && u.id !== me.id && <>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(async () => { const d = await api<{ temporaryPassword: string }>(`/api/portal/users/${u.id}/reset-password`, { body: {} }); setSecret({ email: u.email, password: d.temporaryPassword }); })}><KeyRound size={13} /> Reset</Button>
                <Button variant={u.active ? "destructive" : "outline"} size="sm" disabled={busy} onClick={() => void run(async () => { await api(`/api/portal/users/${u.id}`, { method: "PUT", body: { active: !u.active } }); })}>{u.active ? "Disable" : "Enable"}</Button>
              </>}</td>
            </tr>;
          })}
          {shown.length === 0 && <tr><td colSpan={6} className="team-empty">No one matches this view.</td></tr>}
        </tbody>
      </table>
    </div>
  </section>;
}
