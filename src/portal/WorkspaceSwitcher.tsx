import { useState } from "react";
import { Building, ChevronsUpDown } from "lucide-react";
import { api, type WorkspaceRef } from "./api";

/**
 * Tenant switcher in the admin top bar. Platform admins can narrow every page to one workspace or see all;
 * workspace admins move between their own workspaces. The choice is a server cookie, so every API call follows it.
 */
export function WorkspaceSwitcher({ workspaces, activeId, scoped }: { workspaces: WorkspaceRef[]; activeId: string | null; scoped: boolean }) {
  const [busy, setBusy] = useState(false);
  if (!workspaces.length) {
    return scoped ? <span className="ws-switch ws-empty" title="Ask a Super Admin to add you to a workspace"><Building size={14} /> No workspace</span> : null;
  }
  if (scoped && workspaces.length === 1) {
    return <span className="ws-switch" title="Your workspace"><Building size={14} /> {workspaces[0].name}</span>;
  }
  const change = async (value: string) => {
    setBusy(true);
    try {
      await api("/api/portal/workspace", { body: { workspaceId: value || null } });
      window.location.reload();
    } catch { setBusy(false); }
  };
  return <label className="ws-switch" title="Switch workspace">
    <Building size={14} />
    <select aria-label="Workspace" value={activeId ?? ""} disabled={busy} onChange={e => void change(e.target.value)}>
      <option value="">{scoped ? "All my workspaces" : "All workspaces"}</option>
      {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
    </select>
    <ChevronsUpDown size={13} />
  </label>;
}
