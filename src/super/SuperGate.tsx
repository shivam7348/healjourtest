import { useEffect, useState } from "react";
import { ArrowRight, LogOut, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, type AuthState } from "../portal/api";
import { ChangePassword, LoginPage } from "../portal/LoginPage";
import SuperConsole from "./SuperConsole";

/** /superadmin: its own sign-in (Super Admins only) and its own console. */
export default function SuperGate() {
  const [state, setState] = useState<AuthState | null>(null);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState("");
  const refresh = async () => {
    try { setState(await api<AuthState>("/api/auth/state")); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not reach the server."); }
  };
  useEffect(() => { void refresh(); }, []);
  const logout = async () => { await api("/api/auth/logout", { body: {} }).catch(() => undefined); setChanging(false); await refresh(); };

  if (error) return <div className="auth-screen su-auth"><div className="auth-card"><h1>Server not reachable</h1><p className="auth-sub">{error}</p></div></div>;
  if (!state) return <div className="auth-screen su-auth"><p className="auth-sub">Loading…</p></div>;
  if (!state.user) {
    if (state.setupNeeded) return <div className="auth-screen su-auth"><div className="auth-card"><h1>Not set up yet</h1><p className="auth-sub">Create the first admin at <a href="/admin">/admin</a>. That account becomes the Super Admin.</p></div></div>;
    return <div className="su-auth"><LoginPage state={state} area="super" onDone={() => void refresh()} /></div>;
  }
  if (state.user.mustChangePassword || changing) {
    return <div className="su-auth"><ChangePassword forced={state.user.mustChangePassword} onDone={() => { setChanging(false); void refresh(); }} onCancel={state.user.mustChangePassword ? undefined : () => setChanging(false)} onBack={() => void logout()} /></div>;
  }
  if (!state.superAdmin) {
    return <div className="auth-screen su-auth"><div className="auth-card">
      <h1><ShieldAlert size={20} /> Super Admins only</h1>
      <p className="auth-sub">You are signed in as {state.user.email}, which is not a Super Admin account.</p>
      <div className="builder-actions">
        <Button variant="default" onClick={() => { window.location.href = state.user!.role === "healjour_admin" ? "/admin" : "/"; }}>Go to my portal <ArrowRight size={15} /></Button>
        <Button variant="outline" onClick={() => void logout()}><LogOut size={14} /> Sign out</Button>
      </div>
    </div></div>;
  }
  return <SuperConsole me={state.user} onLogout={() => void logout()} onChangePassword={() => setChanging(true)} />;
}
