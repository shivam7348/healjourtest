import { useState } from "react";
import { ClipboardList, KeyRound, LogOut, Users, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ROLE_LABEL, type PortalLab, type PortalUser } from "./api";
import { CasesBoard } from "./CasesBoard";
import { TeamPanel } from "./TeamPanel";
import { NotificationBell } from "./NotificationBell";

/** What a partner lab sees after signing in: its cases, and for lab admins its team. */
export function LabPortal({ user, lab, onLogout, onChangePassword }: { user: PortalUser; lab: PortalLab | null; onLogout: () => void; onChangePassword: () => void }) {
  const [tab, setTab] = useState<"cases" | "team">("cases");
  return <div className="lab-portal">
    <header className="lab-portal-top">
      <div className="auth-brand"><div className="brand-mark"><Workflow size={20} /></div><div><b>{lab?.name ?? "Lab"}</b><small>Healjour Lab Portal{lab?.code ? ` · ${lab.code}` : ""}</small></div></div>
      <nav className="lab-portal-tabs">
        <button type="button" className={tab === "cases" ? "on" : ""} onClick={() => setTab("cases")}><ClipboardList size={15} /> Cases</button>
        {user.role === "lab_admin" && <button type="button" className={tab === "team" ? "on" : ""} onClick={() => setTab("team")}><Users size={15} /> Team</button>}
      </nav>
      <div className="lab-portal-user">
        <NotificationBell />
        <span><b>{user.name}</b><small>{ROLE_LABEL[user.role]}</small></span>
        <Button variant="outline" size="sm" onClick={onChangePassword}><KeyRound size={13} /> Password</Button>
        <Button variant="outline" size="sm" onClick={onLogout}><LogOut size={13} /> Sign out</Button>
      </div>
    </header>
    <main className="lab-portal-main">
      {tab === "cases" ? <>
        <div className="page-heading"><div><div className="eyebrow">YOUR CASES</div><h1>Bookings from Healjour</h1><p>{user.role === "lab_viewer" ? "You can read cases and download reports." : "Accept a case, update its status, enter results and upload the report. Healjour sees every update at once."}</p></div></div>
        <CasesBoard role={user.role} />
      </> : <TeamPanel me={user} lab={lab} />}
    </main>
  </div>;
}
