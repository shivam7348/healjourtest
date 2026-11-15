import { useEffect, useState } from "react";
import { Copy, KeyRound, UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, fmtDate, ROLE_LABEL, type PortalLab, type PortalUser, type Role } from "./api";

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
  const isHealjour = me.role === "healjour_admin";
  const roleChoices: Role[] = lab ? (isHealjour ? ["lab_admin", "lab_staff", "lab_viewer"] : ["lab_staff", "lab_viewer"]) : ["healjour_admin"];

  const load = async () => {
    try {
      const data = await api<{ users: PortalUser[] }>(`/api/portal/users${isHealjour ? `?labId=${encodeURIComponent(lab?.id ?? "")}` : ""}`);
      setUsers(lab ? data.users : data.users.filter(u => !u.labId));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load users."); }
  };
  useEffect(() => { setSecret(null); setForm(null); void load(); }, [lab?.id]);

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

  return <section className="access-card">
    <div className="access-card-head">
      <div><h2>{lab ? `${lab.name}: team` : "Healjour admins"}</h2><p>{lab ? "Each person signs in with their own email. Roles decide what they can do." : "People who manage every lab."}</p></div>
      {!form && <Button variant="default" size="sm" onClick={() => setForm({ name: "", email: "", role: roleChoices[roleChoices.length > 1 ? 1 : 0] })}><UserPlus size={14} /> Add user</Button>}
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

    {form && <div className="form-grid">
      <label className="field"><span>Name *</span><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
      <label className="field"><span>Email *</span><input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></label>
      <label className="field"><span>Role *</span><select value={form.role} onChange={e => setForm({ ...form, role: e.target.value as Role })}>{roleChoices.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></label>
      <div className="builder-actions" style={{ alignSelf: "end" }}>
        <Button variant="default" size="sm" disabled={busy || form.name.trim().length < 2 || !form.email.includes("@")} onClick={() => void add()}>Create user</Button>
        <Button variant="outline" size="sm" onClick={() => setForm(null)}>Cancel</Button>
      </div>
    </div>}
    {error && <div className="access-message error"><X size={16} />{error}</div>}

    <div className="access-table-wrap"><table className="access-table">
      <thead><tr><th>NAME</th><th>EMAIL</th><th>ROLE</th><th>STATUS</th><th>LAST SIGN-IN</th><th></th></tr></thead>
      <tbody>{users.map(u => <tr key={u.id}>
        <td><b>{u.name}</b>{u.id === me.id && <small className="muted"> (you)</small>}</td>
        <td>{u.email}</td>
        <td>{manageable(u) && u.id !== me.id ? <select value={u.role} onChange={e => void run(async () => { await api(`/api/portal/users/${u.id}`, { method: "PUT", body: { role: e.target.value } }); })}>
          {roleChoices.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select> : ROLE_LABEL[u.role]}</td>
        <td><span className={`access-status ${u.active ? "active" : "revoked"}`}>{u.active ? (u.mustChangePassword ? "invited" : "active") : "disabled"}</span></td>
        <td><small>{fmtDate(u.lastLoginAt)}</small></td>
        <td>{manageable(u) && u.id !== me.id && <div className="builder-actions" style={{ margin: 0 }}>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(async () => { const d = await api<{ temporaryPassword: string }>(`/api/portal/users/${u.id}/reset-password`, { body: {} }); setSecret({ email: u.email, password: d.temporaryPassword }); })}><KeyRound size={13} /> Reset</Button>
          <Button variant={u.active ? "destructive" : "outline"} size="sm" disabled={busy} onClick={() => void run(async () => { await api(`/api/portal/users/${u.id}`, { method: "PUT", body: { active: !u.active } }); })}>{u.active ? "Disable" : "Enable"}</Button>
        </div>}</td>
      </tr>)}</tbody>
    </table></div>
  </section>;
}
