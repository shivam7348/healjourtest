import { useState } from "react";
import { Eye, Undo2 } from "lucide-react";
import { api } from "./api";

export type Impersonation = { by: { id: string; name: string; email: string }; reason: string; expiresAt: string };

/** Always on screen during "Login as": whose account this is, who opened it, and the way back. */
export function ImpersonationBanner({ userName, impersonation }: { userName: string; impersonation: Impersonation }) {
  const [busy, setBusy] = useState(false);
  const back = async () => {
    setBusy(true);
    try {
      const d = await api<{ redirect: string }>("/api/auth/impersonation/end", { body: {} });
      window.location.href = d.redirect || "/superadmin";
    } catch { setBusy(false); }
  };
  const until = new Date(impersonation.expiresAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  return <div className="imp-banner" role="status">
    <Eye size={15} />
    <span>Logged in as <b>{userName}</b> by Super Admin {impersonation.by.name} · until {until} · everything you do is recorded with both names</span>
    <button type="button" disabled={busy} onClick={() => void back()}><Undo2 size={14} /> Return to Super Admin</button>
  </div>;
}
