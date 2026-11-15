import { useEffect, useState } from "react";
import App from "../App";
import { api, type AuthState } from "./api";
import { ChangePassword, LoginPage } from "./LoginPage";
import { LabPortal } from "./LabPortal";

/**
 * Decides what to show: first-run setup, sign-in, a forced password change, the Lab Portal (lab roles)
 * or the full Healjour admin app.
 */
export default function AuthGate() {
  const [state, setState] = useState<AuthState | null>(null);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    try { setState(await api<AuthState>("/api/auth/state")); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not reach the server."); }
  };
  useEffect(() => { void refresh(); }, []);

  const logout = async () => {
    await api("/api/auth/logout", { body: {} }).catch(() => undefined);
    setChanging(false);
    await refresh();
  };

  if (error) return <div className="auth-screen"><div className="auth-card"><h1>Server not reachable</h1><p className="auth-sub">{error}</p></div></div>;
  if (!state) return <div className="auth-screen"><p className="auth-sub">Loading…</p></div>;
  if (!state.user) return <LoginPage state={state} onDone={() => void refresh()} />;
  if (state.user.mustChangePassword || changing) {
    return <ChangePassword forced={state.user.mustChangePassword} onDone={() => { setChanging(false); void refresh(); }} onCancel={state.user.mustChangePassword ? undefined : () => setChanging(false)} />;
  }
  if (state.user.role !== "healjour_admin") {
    return <LabPortal user={state.user} lab={state.lab} onLogout={() => void logout()} onChangePassword={() => setChanging(true)} />;
  }
  return <App user={state.user} onLogout={() => void logout()} onChangePassword={() => setChanging(true)} />;
}
