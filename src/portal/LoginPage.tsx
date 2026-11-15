import { useState } from "react";
import { KeyRound, LogIn, ShieldCheck, Workflow, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MatchHint, PasswordInput } from "@/components/PasswordInput";
import { api, type AuthState } from "./api";

/** Sign-in for Healjour staff and lab users; on a fresh install, creates the first Healjour admin. */
export function LoginPage({ state, onDone }: { state: AuthState; onDone: () => void }) {
  const setup = state.setupNeeded;
  const [f, setF] = useState({ name: "", email: "", password: "", confirm: "", setupKey: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      if (setup) {
        if (f.password !== f.confirm) throw new Error("The two passwords do not match.");
        await api("/api/auth/setup", { body: { name: f.name, email: f.email, password: f.password, setupKey: f.setupKey || undefined } });
      } else {
        await api("/api/auth/login", { body: { email: f.email, password: f.password } });
      }
      onDone();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not sign in."); } finally { setBusy(false); }
  };

  return <div className="auth-screen">
    <form className="auth-card" onSubmit={e => void submit(e)}>
      <div className="auth-brand"><div className="brand-mark"><Workflow size={22} /></div><div><b>healjour</b><small>Integration Hub · Lab Portal</small></div></div>
      <h1>{setup ? "Set up the first admin" : "Sign in"}</h1>
      <p className="auth-sub">{setup ? "No users exist yet. Create the Healjour admin account. You can add labs and their users after this." : "Healjour team and partner labs sign in here. Labs see only their own cases."}</p>
      {setup && <label className="field"><span>Your name</span><input value={f.name} onChange={set("name")} autoComplete="name" required /></label>}
      <label className="field"><span>Email</span><input type="email" value={f.email} onChange={set("email")} autoComplete="username" required /></label>
      <label className="field"><span>Password</span><PasswordInput value={f.password} onChange={set("password")} autoComplete={setup ? "new-password" : "current-password"} required />{setup && <small>At least 10 characters, with letters and a digit.</small>}</label>
      {setup && <label className="field"><span>Confirm password</span><PasswordInput value={f.confirm} onChange={set("confirm")} autoComplete="new-password" required /><MatchHint value={f.password} confirm={f.confirm} /></label>}
      {setup && state.setupKeyRequired && <label className="field"><span>Setup key</span><input value={f.setupKey} onChange={set("setupKey")} /><small>The value of PORTAL_SETUP_KEY on the server.</small></label>}
      {error && <div className="access-message error"><X size={16} />{error}</div>}
      <Button type="submit" variant="default" disabled={busy}>{setup ? <><ShieldCheck size={15} /> Create admin and sign in</> : <><LogIn size={15} /> {busy ? "Signing in…" : "Sign in"}</>}</Button>
      {!setup && <p className="auth-foot">Forgot your password? Ask your lab admin or Healjour to reset it.</p>}
    </form>
  </div>;
}

/** Shown after a reset or for a new user: the one-time password must be replaced before anything else. */
export function ChangePassword({ forced, onDone, onCancel }: { forced?: boolean; onDone: () => void; onCancel?: () => void }) {
  const [f, setF] = useState({ current: "", next: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      if (f.next !== f.confirm) throw new Error("The two new passwords do not match.");
      await api("/api/auth/password", { body: { current: f.current, next: f.next } });
      onDone();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not change the password."); } finally { setBusy(false); }
  };
  return <div className="auth-screen">
    <form className="auth-card" onSubmit={e => void submit(e)}>
      <h1><KeyRound size={20} /> {forced ? "Set your own password" : "Change password"}</h1>
      <p className="auth-sub">{forced ? "You signed in with a one-time password. Choose your own to continue." : "Other devices will be signed out."}</p>
      <label className="field"><span>{forced ? "One-time password" : "Current password"}</span><PasswordInput value={f.current} onChange={e => setF({ ...f, current: e.target.value })} autoComplete="current-password" required /></label>
      <label className="field"><span>New password</span><PasswordInput value={f.next} onChange={e => setF({ ...f, next: e.target.value })} autoComplete="new-password" required /><small>At least 10 characters, with letters and a digit.</small></label>
      <label className="field"><span>Confirm new password</span><PasswordInput value={f.confirm} onChange={e => setF({ ...f, confirm: e.target.value })} autoComplete="new-password" required /><MatchHint value={f.next} confirm={f.confirm} /></label>
      {error && <div className="access-message error"><X size={16} />{error}</div>}
      <div className="builder-actions">
        <Button type="submit" variant="default" disabled={busy}>{busy ? "Saving…" : "Save password"}</Button>
        {onCancel && <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  </div>;
}
