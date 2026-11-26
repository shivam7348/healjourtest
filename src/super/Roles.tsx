import { Fragment, useEffect, useState } from "react";
import { Copy, Plus, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { call, type Run } from "./parts";
import { CreatedBy, type CreatorData } from "../lib/record-tags";

type Page = { label: string; section: string; module: string; scope?: "platform" | "workspace" };
type PageEntry = [id: string, page: Page];
type Section = { label: string; pages: PageEntry[]; modules: string[] };
type Role = {
  id: string; name: string; description: string; permissions: string[];
  pages?: string[]; effectivePages: string[]; builtIn: boolean; admins?: number;
  createdAt?: string; updatedAt?: string; creator?: CreatorData; updater?: CreatorData;
};
type Draft = Pick<Role, "name" | "description" | "permissions" | "pages"> & { id?: string };
type AccessData = {
  roles: Role[];
  modules: Record<string, { label: string; description: string }>;
  actions: Record<string, string>;
  pages: Record<string, Page>;
};
type Preset = { label: string; actions: string[] | "all"; pages?: string[]; sections?: string[] };

const PRESETS: Preset[] = [
  { label: "Nothing", actions: [] },
  { label: "Read-only everywhere", actions: ["view"] },
  { label: "Everything", actions: "all" },
  { label: "Order desk", actions: ["view", "create"], pages: ["orders-bookings", "booking-tracker"] },
  { label: "Lab manager", actions: ["view", "create", "edit", "export"], sections: ["Labs & Catalogue"] },
  { label: "Integration engineer", actions: ["view", "create", "edit", "export"], sections: ["Integration Products", "Developers"] }
];

function AccessCheckbox({ label, checked, mixed = false, onChange }: {
  label: string; checked: boolean; mixed?: boolean; onChange: () => void;
}) {
  return <input
    type="checkbox"
    aria-label={label}
    checked={checked}
    ref={input => { if (input) input.indeterminate = mixed; }}
    onChange={onChange}
  />;
}

function PageSummary({ sections, pageIds }: { sections: Section[]; pageIds: string[] }) {
  if (!pageIds.length) return <span className="su-chip">No pages</span>;
  const visible = sections
    .map(section => ({ ...section, pages: section.pages.filter(([id]) => pageIds.includes(id)) }))
    .filter(section => section.pages.length);
  return <>
    {visible.map(section => <span key={section.label} className="su-chip">{section.label}</span>)}
    <details className="mt-1">
      <summary className="cursor-pointer text-xs">{pageIds.length} {pageIds.length === 1 ? "page" : "pages"}</summary>
      {visible.map(section => <div className="mt-1" key={section.label}>
        <small>{section.label}</small>
        {section.pages.map(([id, page]) => <span className="su-chip" key={id}>{page.label}</span>)}
      </div>)}
    </details>
  </>;
}

export function RolesTab({ run }: { run: Run }) {
  const [data, setData] = useState<AccessData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);

  const load = async () => {
    try {
      setData(await call<AccessData>("/api/super/roles"));
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load roles.");
    }
  };
  useEffect(() => { void load(); }, []);

  const retry = loadError && <p role="alert" className="flex flex-wrap items-center gap-2">
    {loadError} <Button variant="outline" size="sm" onClick={() => void load()}>Retry</Button>
  </p>;
  if (!data) return <section className="su-card">{retry || <p role="status">Loading roles…</p>}</section>;

  const { roles, modules, actions, pages } = data;
  const acts = Object.keys(actions);
  const pageEntries = Object.entries(pages);
  const sectionNames = [...new Set(pageEntries.map(([, page]) => page.section))];
  const sections = sectionNames.map(label => {
    const entries = pageEntries.filter(([, page]) => page.section === label);
    return { label, pages: entries, modules: [...new Set(entries.map(([, page]) => page.module))] };
  });

  const has = (module: string, action: string) => Boolean(draft?.permissions.includes(`${module}.${action}`));
  const visible = pageEntries.filter(([id, page]) =>
    has(page.module, "view") && (!draft?.pages?.length || draft.pages.includes(id))
  ).map(([id]) => id);
  const withoutModules = (permissions: string[], group: string[]) =>
    permissions.filter(permission => !group.some(module => permission.startsWith(`${module}.`)));

  const saveAccess = (permissions: string[], selection?: string[]) => {
    if (!draft) return;
    // An empty allowlist means inherited access, so any remaining view grants must be cleared first.
    const nextPermissions = selection?.length === 0 ? withoutModules(permissions, Object.keys(modules).filter(module =>
      permissions.includes(`${module}.view`)
    )) : permissions;
    setDraft({
      ...draft,
      permissions: [...new Set(nextPermissions)],
      pages: selection?.length ? [...new Set(selection)] : undefined
    });
  };

  const togglePage = (id: string) => {
    if (!draft) return;
    const module = pages[id].module;
    if (!visible.includes(id)) {
      saveAccess([...draft.permissions, `${module}.view`], [...visible, id]);
      return;
    }
    const remaining = visible.filter(pageId => pageId !== id);
    const permissions = remaining.some(pageId => pages[pageId].module === module)
      ? draft.permissions
      : withoutModules(draft.permissions, [module]);
    saveAccess(permissions, remaining);
  };

  const toggleAction = (group: string[], action: string) => {
    if (!draft) return;
    if (group.every(module => has(module, action))) {
      if (action === "view") {
        saveAccess(withoutModules(draft.permissions, group), draft.pages?.filter(id => !group.includes(pages[id]?.module)));
      } else {
        saveAccess(draft.permissions.filter(permission => !group.some(module => permission === `${module}.${action}`)), draft.pages);
      }
      return;
    }
    const newlyVisible = pageEntries.filter(([, page]) => group.includes(page.module) && !has(page.module, "view"));
    saveAccess(
      [...draft.permissions, ...group.flatMap(module => [`${module}.view`, `${module}.${action}`])],
      draft.pages?.length ? [...draft.pages, ...newlyVisible.map(([id]) => id)] : undefined
    );
  };

  const fullSection = (section: Section) =>
    section.pages.every(([id]) => visible.includes(id)) &&
    section.modules.every(module => acts.every(action => has(module, action)));

  const toggleSection = (section: Section) => {
    if (!draft) return;
    if (fullSection(section)) {
      saveAccess(withoutModules(draft.permissions, section.modules), draft.pages?.filter(id => pages[id]?.section !== section.label));
    } else {
      saveAccess(
        [...draft.permissions, ...section.modules.flatMap(module => acts.map(action => `${module}.${action}`))],
        draft.pages?.length ? [...draft.pages, ...section.pages.map(([id]) => id)] : undefined
      );
    }
  };

  const applyPreset = (preset: Preset) => {
    const subset = preset.pages || preset.sections
      ? pageEntries.filter(([id, page]) => preset.pages?.includes(id) || preset.sections?.includes(page.section))
      : undefined;
    const group = subset ? [...new Set(subset.map(([, page]) => page.module))] : Object.keys(modules);
    const grantActions = preset.actions === "all" ? acts : preset.actions;
    saveAccess(group.flatMap(module => grantActions.map(action => `${module}.${action}`)), subset?.map(([id]) => id));
  };

  const openDraft = (role: Role, copy = false) => setDraft({
    id: copy ? undefined : role.id,
    name: copy ? `${role.name} copy` : role.name,
    description: role.description,
    permissions: role.permissions,
    pages: role.pages?.length ? role.pages : undefined
  });
  const save = () => draft && run(async () => {
    const body = { name: draft.name, description: draft.description, permissions: draft.permissions, pages: draft.pages ?? [] };
    if (draft.id) await call(`/api/super/roles/${draft.id}`, "PUT", body);
    else await call("/api/super/roles", "POST", body);
    setDraft(null);
    await load();
    return `Role "${draft.name}" saved. Admins with this role get the new access on their next page load.`;
  });
  const remove = (role: Role) => {
    if (!window.confirm(`Delete the role "${role.name}"? This cannot be undone.`)) return;
    void run(async () => {
      await call(`/api/super/roles/${role.id}`, "DELETE");
      await load();
      return `Role "${role.name}" deleted.`;
    });
  };

  const actionCells = (label: string, group: string[]) => acts.map(action => {
    const checked = group.every(module => has(module, action));
    return <td key={action}><AccessCheckbox
      label={`${label} ${action}`}
      checked={checked}
      mixed={!checked && group.some(module => has(module, action))}
      onChange={() => toggleAction(group, action)}
    /></td>;
  });

  return <div className="su-stack">
    {retry}
    {draft && <section className="su-card">
      <div className="su-card-head">
        <div>
          <h2>{draft.id ? `Edit role: ${draft.name}` : "New role"}</h2>
          <p>Choose the pages admins can open and the actions they can take in each module. Pages marked <span className="ws-badge">Platform</span> hold data shared by every tenant: admins limited to workspaces never get them, even if ticked here.</p>
        </div>
      </div>
      <div className="su-form2">
        <label className="field"><span>Role name</span><input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Order desk" /></label>
        <label className="field"><span>Description</span><input value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} placeholder="Who gets this role and why" /></label>
      </div>
      <div className="su-presets"><span>Quick start</span>
        {PRESETS.map(preset => <button key={preset.label} type="button" onClick={() => applyPreset(preset)}>{preset.label}</button>)}
      </div>
      <div className="su-matrix-wrap"><table className="su-matrix">
        <thead>
          <tr>
            <th scope="col">Section and pages</th>
            {acts.map(action => <th key={action} scope="col" className="capitalize" title={actions[action]}>{action}</th>)}
            <th scope="col" title="Grant or remove all pages and actions in the section">Full access</th>
          </tr>
        </thead>
        <tbody>
          {sections.map(section => {
            const all = fullSection(section);
            const some = section.pages.some(([id]) => visible.includes(id)) ||
              section.modules.some(module => acts.some(action => has(module, action)));
            return <Fragment key={section.label}>
              <tr className="bg-violet-50/60">
                <td><b>{section.label}</b></td>
                {actionCells(section.label, section.modules)}
                <td><AccessCheckbox label={`Full access to ${section.label}`} checked={all} mixed={!all && some} onChange={() => toggleSection(section)} /></td>
              </tr>
              {section.modules.length > 1 && section.modules.map(module => <tr key={module}>
                <td><span className="pl-3" title={modules[module].description}>{modules[module].label}</span></td>
                {actionCells(modules[module].label, [module])}
                <td />
              </tr>)}
              <tr>
                <td colSpan={acts.length + 2}>
                  <div className="grid grid-cols-3 gap-x-4 gap-y-2 pl-3">
                    {section.pages.map(([id, page]) => <label className="flex cursor-pointer items-center gap-2" key={id}>
                      <AccessCheckbox label={page.label} checked={visible.includes(id)} onChange={() => togglePage(id)} />
                      {page.label}
                      {page.scope === "platform" && <span className="ws-badge" title="Shared by every tenant: platform admins only">Platform</span>}
                    </label>)}
                  </div>
                </td>
              </tr>
            </Fragment>;
          })}
        </tbody>
      </table></div>
      <div className="su-legend">{acts.map(action => <span key={action}><b>{action}</b> {actions[action]}</span>)}</div>
      <div className="builder-actions">
        <Button variant="default" disabled={draft.name.trim().length < 2} onClick={() => void save()}><Save size={14} /> Save role</Button>
        <Button variant="outline" onClick={() => setDraft(null)}>Cancel</Button>
      </div>
    </section>}

    <section className="su-card">
      <div className="su-card-head">
        <div><h2>Roles</h2><p>Assign one role per admin. Super Admins have access to every page and this console.</p></div>
        {!draft && <Button variant="default" onClick={() => setDraft({ name: "", description: "", permissions: [] })}><Plus size={15} /> New role</Button>}
      </div>
      <div className="su-table-wrap"><table className="su-table">
        <thead><tr><th scope="col">Role</th><th scope="col">Page access</th><th scope="col">Admins</th><th scope="col">Manage</th></tr></thead>
        <tbody>
          <tr className="su-super-row">
            <td><b>Super Admin</b><small>Full access and Super Admin console</small></td>
            <td><PageSummary sections={sections} pageIds={Object.keys(pages)} /></td>
            <td>—</td>
            <td />
          </tr>
          {roles.map(role => <tr key={role.id}>
            <td>
              <b>{role.name}</b>
              <small>{role.builtIn ? "Built in · " : ""}{role.permissions.length} action grants</small>
              {role.description && <small>{role.description}</small>}
              <CreatedBy creator={role.creator} at={role.createdAt} />
              {role.updater && role.updatedAt !== role.createdAt && <CreatedBy label="Last changed by" creator={role.updater} at={role.updatedAt} />}
            </td>
            <td><PageSummary sections={sections} pageIds={role.effectivePages} /></td>
            <td>{role.admins ?? 0}</td>
            <td className="su-actions">
              {!role.builtIn && <Button variant="outline" size="sm" onClick={() => openDraft(role)}>Edit</Button>}
              <button type="button" className="corp-icon" aria-label={`Copy ${role.name} as a new role`} onClick={() => openDraft(role, true)}><Copy size={13} /></button>
              {!role.builtIn && <button type="button" className="corp-icon danger" aria-label={`Delete ${role.name}`} onClick={() => remove(role)}><Trash2 size={13} /></button>}
            </td>
          </tr>)}
        </tbody>
      </table></div>
    </section>
  </div>;
}
