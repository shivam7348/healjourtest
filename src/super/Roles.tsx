import { useEffect, useState } from "react";
import { Copy, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { call, type Run } from "./parts";

type Modules = Record<string, { label: string; description: string }>;
type Actions = Record<string, string>;
type Role = { id: string; name: string; description: string; permissions: string[]; builtIn: boolean; admins?: number };
type Draft = { id?: string; name: string; description: string; permissions: string[] };

/**
 * Roles & permissions: each role is a grid of modules × actions (view, create, edit, delete, export).
 * The admin sidebar shows a module only with "view"; the server checks every action on every call.
 */
export function RolesTab({ run }: { run: Run }) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [modules, setModules] = useState<Modules>({});
  const [actions, setActions] = useState<Actions>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const load = () => call<{ roles: Role[]; modules: Modules; actions: Actions }>("/api/super/roles").then(d => { setRoles(d.roles); setModules(d.modules); setActions(d.actions); }).catch(() => undefined);
  useEffect(() => { void load(); }, []);
  const mods = Object.keys(modules), acts = Object.keys(actions);

  const has = (p: string) => Boolean(draft?.permissions.includes(p));
  const setPerms = (next: string[]) => draft && setDraft({ ...draft, permissions: [...new Set(next)] });
  // Any action without "view" is useless (the page is hidden), so ticking an action also ticks view; unticking view clears the row.
  const toggle = (m: string, a: string) => {
    if (!draft) return;
    const p = `${m}.${a}`;
    if (has(p)) setPerms(a === "view" ? draft.permissions.filter(x => !x.startsWith(`${m}.`)) : draft.permissions.filter(x => x !== p));
    else setPerms([...draft.permissions, p, `${m}.view`]);
  };
  const rowAll = (m: string) => draft && (acts.every(a => has(`${m}.${a}`)) ? setPerms(draft.permissions.filter(x => !x.startsWith(`${m}.`))) : setPerms([...draft.permissions, ...acts.map(a => `${m}.${a}`)]));
  const colAll = (a: string) => {
    if (!draft) return;
    if (mods.every(m => has(`${m}.${a}`))) setPerms(a === "view" ? [] : draft.permissions.filter(x => !x.endsWith(`.${a}`)));
    else setPerms([...draft.permissions, ...mods.flatMap(m => [`${m}.${a}`, `${m}.view`])]);
  };
  const preset = (kind: "none" | "read" | "all") => draft && setPerms(kind === "none" ? [] : kind === "read" ? mods.map(m => `${m}.view`) : mods.flatMap(m => acts.map(a => `${m}.${a}`)));

  const save = () => draft && run(async () => {
    const body = { name: draft.name, description: draft.description, permissions: draft.permissions };
    if (draft.id) await call(`/api/super/roles/${draft.id}`, "PUT", body); else await call("/api/super/roles", "POST", body);
    setDraft(null); await load();
    return `Role "${draft.name}" saved. Admins with this role get the new access on their next page load.`;
  });
  const remove = (r: Role) => {
    if (!window.confirm(`Delete the role "${r.name}"? This cannot be undone.`)) return;
    void run(async () => { await call(`/api/super/roles/${r.id}`, "DELETE"); await load(); return `Role "${r.name}" deleted.`; });
  };
  const summary = (r: Role) => {
    const n = r.permissions.length, total = mods.length * acts.length;
    return n === total ? "Everything" : n === 0 ? "No access" : `${mods.filter(m => r.permissions.includes(`${m}.view`)).length} module(s), ${n} permission(s)`;
  };

  return <div className="su-stack">
    {draft && <section className="su-card">
      <div className="su-card-head"><div><h2>{draft.id ? `Edit role: ${draft.name}` : "New role"}</h2><p>Tick what this role may do in each module. Every change is recorded in the audit log.</p></div></div>
      <div className="su-form2">
        <label className="field"><span>Role name</span><input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Order desk" /></label>
        <label className="field"><span>Description</span><input value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} placeholder="Who gets this role and why" /></label>
      </div>
      <div className="su-presets"><span>Quick start:</span>
        <button type="button" onClick={() => preset("none")}>Nothing</button>
        <button type="button" onClick={() => preset("read")}>Read-only everywhere</button>
        <button type="button" onClick={() => preset("all")}>Everything</button>
      </div>
      <div className="su-matrix-wrap"><table className="su-matrix">
        <thead><tr><th>Module</th>{acts.map(a => <th key={a}><button type="button" title={actions[a]} onClick={() => colAll(a)}>{a}</button></th>)}<th>All</th></tr></thead>
        <tbody>{mods.map(m => <tr key={m}>
          <td><b>{modules[m].label}</b><small>{modules[m].description}</small></td>
          {acts.map(a => <td key={a}><input type="checkbox" aria-label={`${modules[m].label} ${a}`} checked={has(`${m}.${a}`)} onChange={() => toggle(m, a)} /></td>)}
          <td><input type="checkbox" aria-label={`${modules[m].label} all`} checked={acts.every(a => has(`${m}.${a}`))} onChange={() => rowAll(m)} /></td>
        </tr>)}</tbody>
      </table></div>
      <div className="su-legend">{acts.map(a => <span key={a}><b>{a}</b> {actions[a]}</span>)}</div>
      <div className="builder-actions"><Button variant="default" disabled={draft.name.trim().length < 2} onClick={() => void save()}><Save size={14} /> Save role</Button><Button variant="outline" onClick={() => setDraft(null)}>Cancel</Button></div>
    </section>}

    <section className="su-card">
      <div className="su-card-head"><div><h2>Roles</h2><p>Give each admin one role in Admins. Super Admins always have everything.</p></div>
        {!draft && <Button variant="default" onClick={() => setDraft({ name: "", description: "", permissions: [] })}><Plus size={15} /> New role</Button>}</div>
      <div className="su-table-wrap"><table className="su-table su-perm-table">
        <thead><tr><th>Role</th>{mods.map(m => <th key={m}>{modules[m].label}</th>)}<th>Admins</th><th /></tr></thead>
        <tbody>
          <tr className="su-super-row"><td><b>Super Admin</b><small>Everything + this console</small></td>{mods.map(m => <td key={m}><span className="su-chip all">all</span></td>)}<td>—</td><td /></tr>
          {roles.map(r => <tr key={r.id}>
            <td><b>{r.name}</b><small>{r.builtIn ? "Built in · " : ""}{summary(r)}</small></td>
            {mods.map(m => {
              const list = acts.filter(a => r.permissions.includes(`${m}.${a}`));
              return <td key={m}>{list.length === acts.length ? <span className="su-chip all">all</span> : list.length === 0 ? <span className="su-chip none">—</span> : list.map(a => <span key={a} className="su-chip">{a}</span>)}</td>;
            })}
            <td>{r.admins ?? 0}</td>
            <td className="su-actions">
              {!r.builtIn && <Button variant="outline" size="sm" onClick={() => setDraft({ id: r.id, name: r.name, description: r.description, permissions: r.permissions })}>Edit</Button>}
              <button type="button" className="corp-icon" title="Copy as a new role" onClick={() => setDraft({ name: `${r.name} copy`, description: r.description, permissions: r.permissions })}><Copy size={13} /></button>
              {!r.builtIn && <button type="button" className="corp-icon danger" aria-label={`Delete ${r.name}`} onClick={() => remove(r)}><Trash2 size={13} /></button>}
            </td>
          </tr>)}
        </tbody>
      </table></div>
    </section>
  </div>;
}
