import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { call, when, type Run } from "./parts";

type Lab = { id: string; code: string; name: string; city?: string; active: boolean; users: number; createdAt: string };
type System = { sessionHours: number; maintenance: boolean; maintenanceMessage: string; updatedAt?: string; updatedBy?: string };

/** Pause or resume a whole partner lab. Pausing signs its users out and blocks their sign-in. */
export function LabsTab({ run }: { run: Run }) {
  const [labs, setLabs] = useState<Lab[]>([]);
  const load = () => call<{ labs: Lab[] }>("/api/super/labs").then(d => setLabs(d.labs)).catch(() => undefined);
  useEffect(() => { void load(); }, []);
  const toggle = (l: Lab) => {
    if (l.active && !window.confirm(`Pause ${l.name}? Its ${l.users} user(s) are signed out and cannot sign in until you resume it.`)) return;
    void run(async () => { await call(`/api/super/labs/${l.id}`, "PUT", { active: !l.active }); await load(); return l.active ? `${l.name} paused.` : `${l.name} resumed.`; });
  };
  return <section className="su-card">
    <div className="su-card-head"><div><h2>Partner labs</h2><p>Pausing a lab locks out all its users at once. Resume to let them back in.</p></div></div>
    <div className="su-table-wrap"><table className="su-table">
      <thead><tr><th>Lab</th><th>Code</th><th>City</th><th>Users</th><th>Status</th><th /></tr></thead>
      <tbody>{labs.map(l => <tr key={l.id}>
        <td><b>{l.name}</b><small>since {when(l.createdAt)}</small></td><td><code>{l.code}</code></td><td>{l.city ?? "—"}</td><td>{l.users}</td>
        <td><span className={`sa-pill ${l.active ? "ok" : "bad"}`}>{l.active ? "Active" : "Paused"}</span></td>
        <td><Button variant={l.active ? "destructive" : "outline"} size="sm" onClick={() => toggle(l)}>{l.active ? "Pause" : "Resume"}</Button></td>
      </tr>)}</tbody>
    </table></div>
  </section>;
}

/** Session length and maintenance mode. */
export function SecurityTab({ run }: { run: Run }) {
  const [s, setS] = useState<System | null>(null);
  const load = () => call<System>("/api/super/system").then(setS).catch(() => undefined);
  useEffect(() => { void load(); }, []);
  if (!s) return <p className="sa-muted">Loading…</p>;
  const save = () => {
    if (s.maintenance && !window.confirm("Turn on maintenance mode? Everyone except Super Admins is signed out and cannot sign in until you turn it off.")) return;
    void run(async () => { await call("/api/super/system", "PUT", { sessionHours: s.sessionHours, maintenance: s.maintenance, maintenanceMessage: s.maintenanceMessage }); await load(); return "Security settings saved."; });
  };
  return <section className="su-card">
    <div className="su-card-head"><div><h2>Security & system</h2><p>{s.updatedAt ? `Last changed ${when(s.updatedAt)} by ${s.updatedBy}.` : "Default settings."}</p></div></div>
    <div className="su-settings">
      <label className="field"><span>Session length (hours)</span>
        <input type="number" min={1} max={72} value={s.sessionHours} onChange={e => setS({ ...s, sessionHours: Number(e.target.value) })} />
        <small>How long a sign-in lasts for everyone (1–72). Applies to new sign-ins.</small></label>
      <div className={`su-maint ${s.maintenance ? "on" : ""}`}>
        <label className="su-switch"><input type="checkbox" checked={s.maintenance} onChange={e => setS({ ...s, maintenance: e.target.checked })} /> <b>Maintenance mode</b></label>
        <small>Only Super Admins can sign in or use the app. Admins and lab users see the message below.</small>
        <label className="field"><span>Message shown to everyone else</span><textarea rows={2} value={s.maintenanceMessage} onChange={e => setS({ ...s, maintenanceMessage: e.target.value })} /></label>
      </div>
      <div className="su-info">
        <b>Always on</b>
        <ul>
          <li>Passwords stored as scrypt hashes; new users must set their own password at first sign-in.</li>
          <li>5 wrong passwords lock that email + address for 15 minutes.</li>
          <li>Session cookies are httpOnly, SameSite=Lax, and Secure on https.</li>
          <li>Every Super Admin action is written to the hash-chained audit log.</li>
        </ul>
      </div>
    </div>
    <div className="builder-actions"><Button variant="default" disabled={s.sessionHours < 1 || s.sessionHours > 72 || s.maintenanceMessage.trim().length < 5} onClick={save}><Save size={14} /> Save</Button></div>
  </section>;
}
