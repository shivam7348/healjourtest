import { useState } from "react";
import { Activity, Building2, ExternalLink, KeyRound, LayoutDashboard, LockKeyhole, LogOut, ScrollText, ShieldCheck, UserCog, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PortalUser } from "../portal/api";
import { AdminsTab, AuditTab, OverviewTab, SessionsTab, UsersTab } from "./parts";
import { RolesTab } from "./Roles";
import { LabsTab, SecurityTab } from "./System";

type Page = "dashboard" | "admins" | "roles" | "users" | "labs" | "sessions" | "audit" | "security";
const NAV: Array<{ id: Page; label: string; icon: typeof LayoutDashboard; group: string }> = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, group: "OVERVIEW" },
  { id: "admins", label: "Admins", icon: UserCog, group: "ACCESS CONTROL" },
  { id: "roles", label: "Roles & permissions", icon: KeyRound, group: "ACCESS CONTROL" },
  { id: "users", label: "All users", icon: Users, group: "ACCESS CONTROL" },
  { id: "labs", label: "Partner labs", icon: Building2, group: "ORGANISATION" },
  { id: "sessions", label: "Sessions", icon: Activity, group: "MONITORING" },
  { id: "audit", label: "Audit log", icon: ScrollText, group: "MONITORING" },
  { id: "security", label: "Security & system", icon: LockKeyhole, group: "SYSTEM" }
];
const TITLES: Record<Page, [string, string]> = {
  dashboard: ["Dashboard", "Everything at a glance: people, labs, sessions and recent changes."],
  admins: ["Admins", "Add admins, give each a role, make or remove Super Admins, reset passwords, sign out or disable."],
  roles: ["Roles & permissions", "Decide exactly what each admin role can view, create, edit, delete and export, module by module."],
  users: ["All users", "Every Healjour admin and lab user. Disable or sign out anyone."],
  labs: ["Partner labs", "Pause or resume a whole lab and all its users."],
  sessions: ["Sessions", "Who is signed in right now, and from where."],
  audit: ["Audit log", "Every change, who made it and when. Tamper-evident."],
  security: ["Security & system", "Session length and maintenance mode."]
};

/** The Super Admin console at /superadmin: its own layout, separate from the admin panel. */
export default function SuperConsole({ me, onLogout, onChangePassword }: { me: PortalUser; onLogout: () => void; onChangePassword: () => void }) {
  const [page, setPage] = useState<Page>(() => { try { return (sessionStorage.getItem("su-page") as Page) || "dashboard"; } catch { return "dashboard"; } });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const go = (p: Page) => { setPage(p); setError(""); setNotice(""); setMenuOpen(false); try { sessionStorage.setItem("su-page", p); } catch { /* ignore */ } };
  const run = async (task: () => Promise<string>) => {
    setError(""); setNotice("");
    try { setNotice(await task()); } catch (e) { setError(e instanceof Error ? e.message : "Failed."); }
  };
  const groups = [...new Set(NAV.map(n => n.group))];
  const [title, sub] = TITLES[page];

  return <div className="su-shell">
    <aside className={`su-side${menuOpen ? " open" : ""}`}>
      <div className="su-brand"><span className="su-mark"><ShieldCheck size={18} /></span><div><b>healjour</b><small>Super Admin</small></div></div>
      <nav className="su-nav">{groups.map(g => <div key={g}>
        <small>{g}</small>
        {NAV.filter(n => n.group === g).map(n => { const Icon = n.icon; return <button key={n.id} type="button" className={page === n.id ? "on" : ""} onClick={() => go(n.id)}><Icon size={16} /> {n.label}</button>; })}
      </div>)}</nav>
      <div className="su-me">
        <span className="su-avatar">{me.name.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase()}</span>
        <span><b>{me.name}</b><small>{me.email}</small></span>
      </div>
    </aside>
    {menuOpen && <div className="su-scrim" onClick={() => setMenuOpen(false)} />}
    <main className="su-main">
      <header className="su-top">
        <button type="button" className="su-burger" aria-label="Menu" onClick={() => setMenuOpen(true)}>☰</button>
        <div><h1>{title}</h1><p>{sub}</p></div>
        <div className="su-top-actions">
          <a className="su-link" href="/admin" target="_blank" rel="noopener noreferrer"><ExternalLink size={14} /> Admin panel</a>
          <Button variant="outline" size="sm" onClick={onChangePassword}><KeyRound size={13} /> Password</Button>
          <Button variant="outline" size="sm" onClick={onLogout}><LogOut size={13} /> Sign out</Button>
        </div>
      </header>
      <div className="su-body">
        {error && <div className="access-message error"><X size={16} />{error}</div>}
        {notice && <div className="access-message success">{notice}</div>}
        {secret && <div className="secret-box">
          <b>One-time password for {secret.email}</b><code>{secret.password}</code>
          <small>Share it privately. It is shown only now; they must set their own password at first sign-in.</small>
          <div className="builder-actions"><Button variant="outline" size="sm" onClick={() => void navigator.clipboard?.writeText(secret.password)}>Copy</Button><Button variant="outline" size="sm" onClick={() => setSecret(null)}>Done</Button></div>
        </div>}
        {page === "dashboard" && <OverviewTab />}
        {page === "admins" && <AdminsTab me={me} run={run} setSecret={setSecret} />}
        {page === "roles" && <RolesTab run={run} />}
        {page === "users" && <UsersTab me={me} run={run} />}
        {page === "labs" && <LabsTab run={run} />}
        {page === "sessions" && <SessionsTab run={run} />}
        {page === "audit" && <AuditTab />}
        {page === "security" && <SecurityTab run={run} />}
      </div>
    </main>
  </div>;
}
