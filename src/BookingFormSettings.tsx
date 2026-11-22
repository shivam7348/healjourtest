import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Clock, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import Picker from "@/components/Picker";
import {
  BOOKING_ONLY, DEFAULT_FIELDS, FIELD_SECTIONS, LOCKED_FIELDS, normalizeFields, parseRelative, relativeDate, relativeValue, sectionOf,
  type FieldConfig, type FieldType
} from "./bookingFields";

const TYPE_LABEL: Record<FieldType, string> = { text: "Text", number: "Number", date: "Date", datetime: "Date & time", select: "Dropdown", textarea: "Long text" };
const TYPE_OPTIONS = (Object.keys(TYPE_LABEL) as FieldType[]).map(t => ({ value: t, label: TYPE_LABEL[t] }));
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

const DESCRIPTIONS: Record<string, string> = {
  first_name: "Needed by Flabs to create the patient",
  contact: "10-digit mobile, country code added automatically",
  age: "Needed by Flabs to create the patient",
  scheduledAt: "Re-evaluated every time the form opens",
  bookingType: "Home collection or a visit to the lab",
  googleLocation: "Map link for the phlebotomist"
};

// Time slots offered as a default: every 30 minutes from 6 AM to 10 PM.
const TIME_SLOTS = Array.from({ length: 33 }, (_, i) => {
  const mins = 6 * 60 + i * 30;
  const hh = String(Math.floor(mins / 60)).padStart(2, "0"), mm = String(mins % 60).padStart(2, "0");
  const h12 = ((Math.floor(mins / 60) + 11) % 12) + 1;
  return { value: `${hh}:${mm}`, label: `${h12}:${mm} ${mins < 720 ? "AM" : "PM"}` };
});
const opensOn = (days: number) => relativeDate(days).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
    className={`bfs-switch${checked ? " on" : ""}`} onClick={() => onChange(!checked)}><span /></button>;
}

/** "Today + [N] days" with the date it opens on. Empty N = no default date. */
function RelativeDays({ value, onChange, disabled }: { value: number | null; onChange: (days: number | null) => void; disabled?: boolean }) {
  return <div className="bfs-rel">
    <div className={`bfs-group${disabled ? " disabled" : ""}`}>
      <span>Today +</span>
      <input type="number" min={0} max={365} inputMode="numeric" disabled={disabled} value={value ?? ""} aria-label="Days from today"
        onChange={e => onChange(e.target.value === "" ? null : Math.max(0, Math.min(365, Math.floor(Number(e.target.value) || 0))))} />
      <span>days</span>
    </div>
    {value !== null && !disabled && <span className="bfs-chip">Opens on {opensOn(value)}</span>}
    {value === null && !disabled && <small className="bfs-muted">Empty = staff choose the date</small>}
  </div>;
}

/**
 * Admin screen for the Flabs booking form, grouped like the form itself: switch a field on or off,
 * make it required, rename it, set what it starts with, reorder it, or add your own fields.
 */
export default function BookingFormSettings() {
  const [fields, setFields] = useState<FieldConfig[]>(normalizeFields(DEFAULT_FIELDS));
  const [draft, setDraft] = useState({ label: "", type: "text" as FieldType, required: false, options: "" });
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
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

  const change = (next: (list: FieldConfig[]) => FieldConfig[]) => { setFields(next); setDirty(true); setNotice(""); };
  const update = (key: string, patch: Partial<FieldConfig>) => change(list => list.map(f => (f.key === key ? { ...f, ...patch } : f)));
  // Moves a field up or down within its own section.
  const move = (key: string, dir: -1 | 1) => change(list => {
    const sec = sectionOf(key);
    const idx = list.map((f, i) => ({ f, i })).filter(x => sectionOf(x.f.key) === sec).map(x => x.i);
    const at = idx.findIndex(i => list[i].key === key);
    const to = idx[at + dir];
    if (to === undefined) return list;
    const next = [...list];
    [next[idx[at]], next[to]] = [next[to], next[idx[at]]];
    return next;
  });
  const remove = (key: string) => change(list => list.filter(f => f.key !== key));

  const addField = () => {
    const label = draft.label.trim();
    if (label.length < 2) return setError("Give the new field a name (at least 2 letters).");
    let key = `custom_${slug(label)}`;
    let n = 2;
    while (fields.some(f => f.key === key)) key = `custom_${slug(label)}_${n++}`;
    const options = draft.type === "select" ? draft.options.split(",").map(s => s.trim()).filter(Boolean) : undefined;
    if (draft.type === "select" && (!options || options.length === 0)) return setError("A dropdown needs at least one option, separated by commas.");
    change(list => [...list, { key, label, type: draft.type, visible: true, required: draft.required, options, custom: true }]);
    setDraft({ label: "", type: "text", required: false, options: "" });
    setError("");
    setNotice(`"${label}" added under Additional information. Click Save to apply it.`);
  };

  const save = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await fetch("/api/booking-form/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not save.");
      setDirty(false);
      setNotice("Saved. The booking form now uses these settings.");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save."); }
    finally { setBusy(false); }
  };

  const resetDefaults = () => {
    if (!window.confirm("Reset the booking form to the default fields? Custom fields will be removed.")) return;
    change(() => normalizeFields(DEFAULT_FIELDS));
    setNotice("Defaults restored. Click Save to apply.");
  };

  const sections = useMemo(() => FIELD_SECTIONS.map(s => ({ ...s, fields: fields.filter(f => sectionOf(f.key) === s.id) })), [fields]);

  /** Left side of a row: editable name, badges, description. */
  const nameCell = (f: FieldConfig, opts: { label?: string; description?: string; editable?: boolean } = {}) => {
    const locked = LOCKED_FIELDS.includes(f.key);
    return <div className="bfs-name">
      <div className="bfs-title">
        {opts.editable === false ? <b>{opts.label ?? f.label}</b>
          : <input className="bfs-label" value={f.label} aria-label={`Name of ${f.key}`} onChange={e => update(f.key, { label: e.target.value })} size={Math.max(6, f.label.length)} />}
        {BOOKING_ONLY.includes(f.key) && <span className="bfs-badge booking">Booking</span>}
        {locked && <span className="bfs-badge locked">Always on</span>}
        {f.custom && <span className="bfs-badge custom">Custom</span>}
      </div>
      <small>{opts.description ?? DESCRIPTIONS[f.key] ?? (f.custom ? `Sent to Flabs as ${f.key}` : TYPE_LABEL[f.type])}</small>
    </div>;
  };

  /** Middle of a row: what the field starts with in the booking form. */
  const defaultCell = (f: FieldConfig) => {
    const off = !f.visible;
    if (f.type === "select") {
      return <div className="bfs-default">
        <Picker value={f.defaultValue ?? ""} disabled={off} ariaLabel={`Default for ${f.label}`} placeholder="No default"
          options={[{ value: "", label: "No default" }, ...(f.options ?? []).map(o => ({ value: o, label: o }))]}
          onChange={v => update(f.key, { defaultValue: v || undefined })} />
        {f.custom && <input className="bfs-input bfs-opts" defaultValue={(f.options ?? []).join(", ")} disabled={off} placeholder="Options, comma separated"
          onBlur={e => update(f.key, { options: e.target.value.split(",").map(s => s.trim()).filter(Boolean) })} />}
      </div>;
    }
    if (f.type === "date" || f.type === "datetime") {
      const rel = parseRelative(f.defaultValue);
      return <div className="bfs-default">
        <RelativeDays value={rel ? rel.days : null} disabled={off} onChange={days => update(f.key, { defaultValue: relativeValue(days, rel?.time ?? "") || undefined })} />
        {f.type === "datetime" && <Picker value={rel?.time ?? ""} disabled={off || !rel} ariaLabel={`Default time for ${f.label}`} placeholder="Select time"
          options={[{ value: "", label: "No default time" }, ...TIME_SLOTS]} onChange={t => update(f.key, { defaultValue: relativeValue(rel?.days ?? 0, t) })} />}
      </div>;
    }
    if (f.type === "textarea") return <div className="bfs-default"><textarea className="bfs-input" rows={2} disabled={off} value={f.defaultValue ?? ""} placeholder="Default text (optional)" onChange={e => update(f.key, { defaultValue: e.target.value || undefined })} /></div>;
    return <div className="bfs-default"><input className="bfs-input" type={f.type === "number" ? "number" : "text"} disabled={off} value={f.defaultValue ?? ""} placeholder="Default value (optional)"
      onChange={e => update(f.key, { defaultValue: e.target.value || undefined })} /></div>;
  };

  /** Right side of a row: required, order, delete, show switch. */
  const controls = (f: FieldConfig, i: number, count: number) => {
    const locked = LOCKED_FIELDS.includes(f.key);
    return <div className="bfs-controls">
      <label className={`bfs-req${f.required ? " on" : ""}${locked || !f.visible ? " disabled" : ""}`}>
        <input type="checkbox" checked={f.required} disabled={locked || !f.visible} onChange={e => update(f.key, { required: e.target.checked })} /> Required
      </label>
      <span className="bfs-move">
        <button type="button" onClick={() => move(f.key, -1)} disabled={i === 0} aria-label={`Move ${f.label} up`}><ArrowUp size={13} /></button>
        <button type="button" onClick={() => move(f.key, 1)} disabled={i === count - 1} aria-label={`Move ${f.label} down`}><ArrowDown size={13} /></button>
      </span>
      {f.custom && <button type="button" className="bfs-del" onClick={() => remove(f.key)} aria-label={`Delete ${f.label}`}><Trash2 size={14} /></button>}
      <Switch checked={f.visible} disabled={locked} label={`Show ${f.label}`} onChange={v => update(f.key, { visible: v, ...(v ? {} : { required: false }) })} />
    </div>;
  };

  /** Booking date is shown as two rows like the form: the date (Today + N days) and the time slot. */
  const scheduleRows = (f: FieldConfig, i: number, count: number) => {
    const rel = parseRelative(f.defaultValue);
    const days = rel ? rel.days : null;
    const time = rel?.time ?? "";
    return [
      <div key="date" className={`bfs-row${f.visible ? "" : " off"}`}>
        {nameCell(f)}
        <div className="bfs-default"><RelativeDays value={days} disabled={!f.visible} onChange={d => update(f.key, { defaultValue: relativeValue(d, time) || undefined })} /></div>
        {controls(f, i, count)}
      </div>,
      <div key="time" className={`bfs-row${f.visible ? "" : " off"}`}>
        {nameCell(f, { label: "Time Slot", editable: false, description: days === null ? "Set a booking date first" : time ? "Pre-filled time; staff can change it" : "Staff choose the time" })}
        <div className="bfs-default">
          <div className="bfs-time">
            <Picker value={time} disabled={!f.visible || days === null} ariaLabel="Default time slot" placeholder="Select time" options={TIME_SLOTS}
              onChange={t => update(f.key, { defaultValue: relativeValue(days ?? 0, t) })} />
            <Clock size={15} />
          </div>
        </div>
        <div className="bfs-controls">
          <Switch checked={Boolean(time)} disabled={!f.visible || days === null} label="Use a default time slot"
            onChange={v => update(f.key, { defaultValue: relativeValue(days ?? 0, v ? "09:00" : "") || undefined })} />
        </div>
      </div>
    ];
  };

  return <section className="access-card bfs">
    <div className="access-card-head">
      <div><h2>Booking form fields</h2><p>Switch a field on or off, make it required, rename it, set what it starts with, or add your own. Required fields must be filled before a booking can be sent to Flabs.</p></div>
      <div className="builder-actions">
        <Button variant="outline" size="sm" onClick={resetDefaults} disabled={busy}><RotateCcw size={13} /> Reset to default</Button>
        <Button variant="default" size="sm" onClick={() => void save()} disabled={busy || !dirty}><Save size={13} /> {busy ? "Saving…" : dirty ? "Save changes" : "Saved"}</Button>
      </div>
    </div>

    {error && <div className="access-message error">{error}</div>}
    {notice && <div className="access-message success">{notice}</div>}

    {sections.map(sec => (sec.fields.length > 0 || sec.id === "custom") && <div key={sec.id} className="bfs-section">
      <h3>{sec.title}</h3>
      <p>{sec.hint}</p>
      <div className="bfs-rows">
        {sec.fields.flatMap((f, i) => f.key === "scheduledAt" ? scheduleRows(f, i, sec.fields.length) : [
          <div key={f.key} className={`bfs-row${f.visible ? "" : " off"}`}>
            {nameCell(f)}
            {defaultCell(f)}
            {controls(f, i, sec.fields.length)}
          </div>
        ])}
        {sec.id === "custom" && <div className="bfs-row bfs-addrow">
          <div className="bfs-name"><div className="bfs-title"><b>Add a field</b></div><small>Values go to Flabs as customFields</small></div>
          <div className="bfs-default bfs-addgrid">
            <input className="bfs-input" value={draft.label} onChange={e => setDraft({ ...draft, label: e.target.value })} placeholder="Field name, e.g. Referral code"
              onKeyDown={e => { if (e.key === "Enter") addField(); }} />
            <Picker value={draft.type} options={TYPE_OPTIONS} ariaLabel="New field type" onChange={v => setDraft({ ...draft, type: v as FieldType })} />
            {draft.type === "select" && <input className="bfs-input" value={draft.options} onChange={e => setDraft({ ...draft, options: e.target.value })} placeholder="Option 1, Option 2" />}
          </div>
          <div className="bfs-controls">
            <label className={`bfs-req${draft.required ? " on" : ""}`}><input type="checkbox" checked={draft.required} onChange={e => setDraft({ ...draft, required: e.target.checked })} /> Required</label>
            <Button variant="outline" size="sm" onClick={addField}><Plus size={14} /> Add</Button>
          </div>
        </div>}
      </div>
    </div>)}

    {dirty && <div className="bfs-savebar">
      <span>You have unsaved changes.</span>
      <Button variant="default" size="sm" onClick={() => void save()} disabled={busy}><Save size={13} /> {busy ? "Saving…" : "Save changes"}</Button>
    </div>}
  </section>;
}
