import { useEffect, useState } from "react";
import { ArrowRight, LogOut, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import App from "../App";
import { api, type AuthState } from "./api";
import { ChangePassword, LoginPage } from "./LoginPage";
import { LabPortal } from "./LabPortal";
import { ImpersonationBanner } from "./ImpersonationBanner";

export type Area = "admin" | "lab";

/**
 * "/" (area "lab"): partner labs sign in and get the Lab Portal.
 * "/admin" (area "admin"): first-run setup, Healjour admin sign-in, then the full admin app.
 * A signed-in user who opens the other area is pointed to the right address.
 */
export default function AuthGate({ area }: { area: Area }) {
  const [state, setState] = useState<AuthState | null>(null);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    try { setState(await api<AuthState>("/api/auth/state")); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not reach the server."); }
  };
  useEffect(() => { void refresh(); }, []);
  // The server retries the database on its own; check again until it is back.
  useEffect(() => {
    if (!state?.storageUnavailable) return;
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [state?.storageUnavailable]);

  const logout = async () => {
    await api("/api/auth/logout", { body: {} }).catch(() => undefined);
    setChanging(false);
    await refresh();
  };

  if (error) return <div className="auth-screen"><div className="auth-card"><h1>Server not reachable</h1><p className="auth-sub">{error}</p></div></div>;
  if (!state) return <div className="auth-screen"><p className="auth-sub">Loading…</p></div>;
  if (state.storageUnavailable) return <div className="auth-screen"><div className="auth-card"><h1>Database not reachable</h1><p className="auth-sub">Reconnecting automatically… This page continues as soon as the database is back. Your data is safe.</p></div></div>;

  const user = state.user;
  if (!user) {
    // First-run setup only on /admin; the lab page just says the portal is not ready yet.
    if (state.setupNeeded && area === "lab") {
      return <div className="auth-screen"><div className="auth-card">
        <h1>Lab Portal is not set up yet</h1>
        <p className="auth-sub">Healjour has not created any accounts yet. Please contact Healjour for your login.</p>
      </div></div>;
    }
    return <LoginPage state={state} area={area} onDone={() => void refresh()} />;
  }
  const imp = state.impersonation ?? null;
  // During "Login as" the password is the user's own business, and signing out means going back to the Super Admin.
  if (!imp && (user.mustChangePassword || changing)) {
    return <ChangePassword forced={user.mustChangePassword} onDone={() => { setChanging(false); void refresh(); }} onCancel={user.mustChangePassword ? undefined : () => setChanging(false)} onBack={() => void logout()} />;
  }
  const signOut = imp
    ? () => void api<{ redirect: string }>("/api/auth/impersonation/end", { body: {} }).then(d => { window.location.href = d.redirect || "/superadmin"; })
    : () => void logout();
  const changePassword = () => { if (!imp) setChanging(true); };
  const banner = imp ? <ImpersonationBanner userName={user.name} impersonation={imp} /> : null;

  const isAdmin = user.role === "healjour_admin";
  if (area === "admin" && !isAdmin) {
    return <>{banner}<WrongArea title="This page is for Healjour admins" text={`You are signed in as a lab user (${user.email}). Your cases are in the Lab Portal.`}
      goLabel="Open Lab Portal" goHref="/" onLogout={signOut} /></>;
  }
  if (area === "lab" && isAdmin) {
    return <>{banner}<WrongArea title="You are a Healjour admin" text="Admins work from the admin dashboard." goLabel="Open admin dashboard" goHref="/admin" onLogout={signOut} /></>;
  }
  if (!isAdmin) return <>{banner}<LabPortal user={user} lab={state.lab} onLogout={signOut} onChangePassword={changePassword} /></>;
  return <>{banner}<App user={user} modules={state.modules} pages={state.pages} superAdmin={Boolean(state.superAdmin)}
    workspace={{ list: state.workspaces ?? [], activeId: state.activeWorkspaceId ?? null, scoped: Boolean(state.workspaceScoped) }}
    onLogout={signOut} onChangePassword={changePassword} /></>;
}

function WrongArea({ title, text, goLabel, goHref, onLogout }: { title: string; text: string; goLabel: string; goHref: string; onLogout: () => void }) {
  return <div className="auth-screen"><div className="auth-card">
    <h1><ShieldAlert size={20} /> {title}</h1>
    <p className="auth-sub">{text}</p>
    <div className="builder-actions">
      <Button variant="default" onClick={() => { window.location.href = goHref; }}>{goLabel} <ArrowRight size={15} /></Button>
      <Button variant="outline" onClick={onLogout}><LogOut size={14} /> Sign out</Button>
    </div>
  </div></div>;
}
