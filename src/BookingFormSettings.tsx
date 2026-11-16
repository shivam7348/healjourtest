import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DEFAULT_FIELDS, LOCKED_FIELDS, normalizeFields, type FieldConfig, type FieldType } from "./bookingFields";

const TYPE_LABEL: Record<FieldType, string> = { text: "Text", number: "Number", date: "Date", datetime: "Date & time", select: "Dropdown", textarea: "Long text" };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

/**
 * Admin screen for the Flabs booking form: choose which patient fields show, which are required,
 * their labels and order, and add custom fields (their values go to Flabs as customFields).
 */
export default function BookingFormSettings() {
  const [fields, setFields] = useState<FieldConfig[]>(normalizeFields(DEFAULT_FIELDS));
  const [draft, setDraft] = useState({ label: "", type: "text" as FieldType, required: false, options: "" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/booking-form/settings");
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "Could not load settings.");
        if (d.fields) setFields(normalizeFields(d.fields));
      } catch (e) { setError(e instanceof Error ? e.message : "Could not load settings."); }
    })();
  }, []);

  const update = (key: string, patch: Partial<FieldConfig>) => setFields(list => list.map(f => (f.key === key ? { ...f, ...patch } : f)));
  const move = (index: number, dir: -1 | 1) => setFields(list => {
    const next = [...list];
    const j = index + dir;
    if (j < 0 || j >= next.length) return list;
    [next[index], next[j]] = [next[j], next[index]];
    return next;
  });
  const remove = (key: string) => setFields(list => list.filter(f => f.key !== key));

  const addField = () => {
    const label = draft.label.trim();
    if (label.length < 2) return setError("Give the new field a name (at least 2 letters).");
    let key = `custom_${slug(label)}`;
    let n = 2;
    while (fields.some(f => f.key === key)) key = `custom_${slug(label)}_${n++}`;
    const options = draft.type === "select" ? draft.options.split(",").map(s => s.trim()).filter(Boolean) : undefined;
    if (draft.type === "select" && (!options || options.length === 0)) return setError("A dropdown needs at least one option, separated by commas.");
    setFields(list => [...list, { key, label, type: draft.type, visible: true, required: draft.required, options, custom: true }]);
    setDraft({ label: "", type: "text", required: false, options: "" });
    setError("");
    setNotice(`"${label}" added. Click Save to apply it to the booking form.`);
  };

  const save = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await fetch("/api/booking-form/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not save.");
      setNotice("Saved. The booking form now uses these fields.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save."); }
    finally { setBusy(false); }
  };

  const resetDefaults = () => {
    if (!window.confirm("Reset the booking form to the default fields? Custom fields will be removed.")) return;
    setFields(normalizeFields(DEFAULT_FIELDS));
    setNotice("Defaults restored. Click Save to apply.");
  };

  return <section className="access-card bfs">
    <div className="access-card-head">
      <div><h2>Booking form fields</h2><p>Show or hide a field, make it required, rename it, change its order, or add your own. Required fields must be filled before a booking can be sent to Flabs.</p></div>
      <div className="builder-actions">
        <Button variant="outline" size="sm" onClick={resetDefaults} disabled={busy}><RotateCcw size={13} /> Reset to default</Button>
        <Button variant="default" size="sm" onClick={() => void save()} disabled={busy}><Save size={13} /> {busy ? "Saving…" : "Save"}</Button>
      </div>
    </div>

    {error && <div className="access-message error">{error}</div>}
    {notice && <div className="access-message success">{notice}</div>}

    <div className="bfs-table-wrap">
      <table className="bfs-table">
        <thead><tr><th>Order</th><th>Field name</th><th>Type</th><th>Show</th><th>Required</th><th>Dropdown options</th><th>Default value</th><th /></tr></thead>
        <tbody>
          {fields.map((f, i) => {
            const locked = LOCKED_FIELDS.includes(f.key);
            return <tr key={f.key} className={f.visible ? "" : "bfs-hidden"}>
              <td className="bfs-order">
                <button type="button" className="bfs-icon" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up"><ArrowUp size={14} /></button>
                <button type="button" className="bfs-icon" onClick={() => move(i, 1)} disabled={i === fields.length - 1} aria-label="Move down"><ArrowDown size={14} /></button>
              </td>
              <td><input className="bfs-input" value={f.label} onChange={e => update(f.key, { label: e.target.value })} />
                <small className="bfs-key">{f.key}{locked ? " · always on" : ""}</small></td>
              <td>{f.custom ? <select className="bfs-input" value={f.type} onChange={e => update(f.key, { type: e.target.value as FieldType })}>
                {(Object.keys(TYPE_LABEL) as FieldType[]).map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select> : <span className="bfs-type">{TYPE_LABEL[f.type]}</span>}</td>
              <td><input type="checkbox" checked={f.visible} disabled={locked} onChange={e => update(f.key, { visible: e.target.checked })} aria-label={`Show ${f.label}`} /></td>
              <td><input type="checkbox" checked={f.required} disabled={locked || !f.visible} onChange={e => update(f.key, { required: e.target.checked })} aria-label={`${f.label} required`} /></td>
              <td>{f.type === "select" ? <input className="bfs-input" defaultValue={(f.options ?? []).join(", ")} onBlur={e => update(f.key, { options: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })} placeholder="comma, separated" />
                : <span className="muted">—</span>}</td>
              <td>{f.type === "select" ? <select className="bfs-input" value={f.defaultValue ?? ""} onChange={e => update(f.key, { defaultValue: e.target.value })}>
                  <option value="">— none —</option>
                  {(f.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
                </select>
                : <input className="bfs-input" type={f.type === "number" ? "number" : f.type === "date" ? "date" : f.type === "datetime" ? "datetime-local" : "text"} value={f.defaultValue ?? ""} onChange={e => update(f.key, { defaultValue: e.target.value })} placeholder="none" />}</td>
              <td>{f.custom && <button type="button" className="bfs-icon danger" onClick={() => remove(f.key)} aria-label={`Delete ${f.label}`}><Trash2 size={14} /></button>}</td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>

    <div className="bfs-add">
      <b>Add a new field</b>
      <div className="bfs-add-grid">
        <label className="field"><span>Field name</span><input value={draft.label} onChange={e => setDraft({ ...draft, label: e.target.value })} placeholder="e.g. Referral code" /></label>
        <label className="field"><span>Type</span>
          <select value={draft.type} onChange={e => setDraft({ ...draft, type: e.target.value as FieldType })}>
            {(Object.keys(TYPE_LABEL) as FieldType[]).map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
        </label>
        {draft.type === "select" && <label className="field"><span>Options</span><input value={draft.options} onChange={e => setDraft({ ...draft, options: e.target.value })} placeholder="Option 1, Option 2" /></label>}
        <label className="bfs-check"><input type="checkbox" checked={draft.required} onChange={e => setDraft({ ...draft, required: e.target.checked })} /> Required</label>
        <Button variant="outline" onClick={addField}><Plus size={14} /> Add field</Button>
      </div>
      <small className="bfs-key">Custom fields are sent to Flabs under the key shown in the table (for example {`custom_${slug(draft.label) || "field_name"}`}).</small>
    </div>
  </section>;
}
