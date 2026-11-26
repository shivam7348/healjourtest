import { useEffect, useMemo, useState } from "react";
import { FlaskConical, Pencil, Plug, Plus, Save, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { call, type Run } from "./parts";
import { CreatedBy, type CreatorData } from "../lib/record-tags";

type Workspace = {
  id: string; tenantId: string; code: string; name: string; description: string; labIds: string[]; connectionIds: string[];
  active: boolean; admins: number; createdAt: string; updatedAt: string; creator?: CreatorData; updater?: CreatorData;
};
type Lab = { id: string; code: string; name: string; active: boolean };
type Conn = { id: string; label: string };
type Data = { workspaces: Workspace[]; labs: Lab[]; connections: Conn[]; platformAdmins: number };
type Draft = { id?: string; code: string; name: string; description: string; labIds: string[]; connectionIds: string[]; active: boolean };

/**
 * Workspaces are tenants. Each owns partner labs and Flabs accounts, and with them their cases, bookings,
 * results and logs. Admins limited to a workspace see only its data and only workspace pages.
 */
export function WorkspacesTab({ run }: { run: Run }) {
  const [data, setData] = useState<Data>({ workspaces: [], labs: [], connections: [], platformAdmins: 0 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [q, setQ] = useState("");
  const load = () => call<Data>("/api/super/workspaces").then(setData).catch(() => undefined);
  useEffect(() => { void load(); }, []);

  // Where each lab / account lives now, so the editor can show items owned by another workspace.
  const owner = useMemo(() => {
    const labs = new Map<string, Workspace>(), conns = new Map<string, Workspace>();
    for (const w of data.workspaces) { w.labIds.forEach(id => labs.set(id, w)); w.connectionIds.forEach(id => conns.set(id, w)); }
    return { labs, conns };
  }, [data.workspaces]);
  const labName = (id: string) => data.labs.find(l => l.id === id)?.name ?? id;
  const connName = (id: string) => data.connections.find(c => c.id === id)?.label ?? id;
  const unassignedLabs = data.labs.filter(l => !owner.labs.has(l.id)).length;
  const unassignedConns = data.connections.filter(c => !owner.conns.has(c.id)).length;

  const save = () => draft && run(async () => {
    const body = { code: draft.code, name: draft.name, description: draft.description, labIds: draft.labIds, connectionIds: draft.connectionIds, active: draft.active };
    if (draft.id) await call(`/api/super/workspaces/${draft.id}`, "PUT", body); else await call("/api/super/workspaces", "POST", body);
    setDraft(null); await load();
    return `Workspace "${draft.name}" saved. Its admins see the change on their next page load.`;
  });
  const remove = (w: Workspace) => {
    if (!window.confirm(`Delete the workspace "${w.name}"? Its labs and Flabs accounts become unassigned (only platform admins will see them). This cannot be undone.`)) return;
    void run(async () => { await call(`/api/super/workspaces/${w.id}`, "DELETE"); await load(); return `Workspace "${w.name}" deleted.`; });
  };
  const toggle = (key: "labIds" | "connectionIds", id: string) => draft && setDraft({
    ...draft, [key]: draft[key].includes(id) ? draft[key].filter(x => x !== id) : [...draft[key], id]
  });
  const match = (text: string) => !q || text.toLowerCase().includes(q.toLowerCase());

  return <div className="sa-stack">
    <div className="sa-stats">
      {([["Workspaces", data.workspaces.length], ["Active", data.workspaces.filter(w => w.active).length], ["Platform admins", data.platformAdmins],
        ["Unassigned labs", unassignedLabs], ["Unassigned Flabs accounts", unassignedConns]] as Array<[string, number]>)
        .map(([l, v]) => <div key={l}><small>{l}</small><b>{v}</b></div>)}
    </div>

    {draft && <section className="access-card">
      <div className="access-card-head"><div><h2>{draft.id ? `Edit workspace: ${draft.name} (${data.workspaces.find(w => w.id === draft.id)?.tenantId ?? ""})` : "New workspace"}</h2>
        <p>Choose the partner labs and Flabs accounts this tenant owns. Each one can belong to one workspace only.</p></div></div>
      <div className="form-grid sa-form">
        <label className="field"><span>Name</span><input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Noida Region" /></label>
        <label className="field"><span>Code</span><input value={draft.code} onChange={e => setDraft({ ...draft, code: e.target.value.toUpperCase() })} placeholder="e.g. NOIDA" /></label>
        <label className="field ws-wide"><span>Description</span><input value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} placeholder="Who works here and what it covers" /></label>
        <label className="sa-check"><input type="checkbox" checked={draft.active} onChange={e => setDraft({ ...draft, active: e.target.checked })} /> Active (paused workspaces are hidden from their admins)</label>
      </div>
      <label className="corp-search ws-search"><Search size={14} /><input placeholder="Filter labs and accounts" value={q} onChange={e => setQ(e.target.value)} /></label>
      <div className="ws-pick">
        <div>
          <h3><FlaskConical size={15} /> Partner labs <small>{draft.labIds.length} selected</small></h3>
          {data.labs.length === 0 && <p className="sa-muted">No partner labs yet. Add them in the admin panel → Labs & Users.</p>}
          {data.labs.filter(l => match(`${l.name} ${l.code}`)).map(l => {
            const other = owner.labs.get(l.id);
            const taken = Boolean(other && other.id !== draft.id);
            return <label key={l.id} className={`ws-item${taken ? " taken" : ""}`}>
              <input type="checkbox" disabled={taken} checked={draft.labIds.includes(l.id)} onChange={() => toggle("labIds", l.id)} />
              <span><b>{l.name}</b><small>{l.code}{!l.active && " · paused"}{taken && ` · in ${other!.name}`}</small></span>
            </label>;
          })}
        </div>
        <div>
          <h3><Plug size={15} /> Flabs accounts <small>{draft.connectionIds.length} selected</small></h3>
          {data.connections.length === 0 && <p className="sa-muted">No Flabs accounts connected yet. Add them in Test Catalog.</p>}
          {data.connections.filter(c => match(c.label)).map(c => {
            const other = owner.conns.get(c.id);
            const taken = Boolean(other && other.id !== draft.id);
            return <label key={c.id} className={`ws-item${taken ? " taken" : ""}`}>
              <input type="checkbox" disabled={taken} checked={draft.connectionIds.includes(c.id)} onChange={() => toggle("connectionIds", c.id)} />
              <span><b>{c.label}</b><small>{taken ? `in ${other!.name}` : "bookings, results and logs follow this account"}</small></span>
            </label>;
          })}
        </div>
      </div>
      <div className="builder-actions ws-actions">
        <Button variant="default" disabled={draft.name.trim().length < 2 || draft.code.trim().length < 2} onClick={() => void save()}><Save size={14} /> Save workspace</Button>
        <Button variant="outline" onClick={() => { setDraft(null); setQ(""); }}>Cancel</Button>
      </div>
    </section>}

    <section className="access-card">
      <div className="access-card-head"><div><h2>Workspaces</h2>
        <p>Tenants of the platform. Give admins workspace access in Admins; platform admins (no workspace) see every tenant.</p></div>
        {!draft && <Button variant="default" onClick={() => setDraft({ code: "", name: "", description: "", labIds: [], connectionIds: [], active: true })}><Plus size={15} /> New workspace</Button>}</div>
      {data.workspaces.length === 0 ? <p className="sa-muted">No workspaces yet. Until you create one, every admin works across all labs and accounts.</p>
        : <div className="sa-table-wrap"><table className="sa-table">
          <thead><tr><th>Workspace</th><th>Partner labs</th><th>Flabs accounts</th><th>Admins</th><th>Status</th><th /></tr></thead>
          <tbody>{data.workspaces.map(w => <tr key={w.id}>
            <td>
              <b>{w.name}</b>
              <button type="button" className="tenant-id" title="Tenant ID: unique and permanent. Click to copy." onClick={() => void navigator.clipboard?.writeText(w.tenantId)}>{w.tenantId}</button>
              <small>{w.code}{w.description && ` · ${w.description}`}</small>
              <CreatedBy creator={w.creator} at={w.createdAt} />
              {w.updater && w.updatedAt !== w.createdAt && <CreatedBy label="Last changed by" creator={w.updater} at={w.updatedAt} />}
            </td>
            <td>{w.labIds.length ? <div className="flex flex-wrap">{w.labIds.map(id => <span key={id} className="su-chip">{labName(id)}</span>)}</div> : <span className="su-chip none">—</span>}</td>
            <td>{w.connectionIds.length ? <div className="flex flex-wrap">{w.connectionIds.map(id => <span key={id} className="su-chip">{connName(id)}</span>)}</div> : <span className="su-chip none">—</span>}</td>
            <td>{w.admins}</td>
            <td><span className={`sa-pill ${w.active ? "ok" : "bad"}`}>{w.active ? "Active" : "Paused"}</span></td>
            <td className="sa-actions">
              <Button variant="outline" size="sm" onClick={() => setDraft({ id: w.id, code: w.code, name: w.name, description: w.description, labIds: w.labIds, connectionIds: w.connectionIds, active: w.active })}><Pencil size={13} /> Edit</Button>
              <button type="button" className="corp-icon danger" aria-label={`Delete ${w.name}`} onClick={() => remove(w)}><Trash2 size={13} /></button>
            </td>
          </tr>)}</tbody>
        </table></div>}
    </section>
  </div>;
}
