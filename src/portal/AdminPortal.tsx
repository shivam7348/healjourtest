import { useEffect, useState } from "react";
import { Building2, CheckCircle2, Plus, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, type PortalLab, type PortalUser } from "./api";
import { CasesBoard } from "./CasesBoard";
import { TeamPanel } from "./TeamPanel";

type CatalogTest = { code: string; name: string; active: boolean };

/** Healjour admin: every lab's cases, with "send booking to lab" on top. */
export function AdminLabCases() {
  const [labs, setLabs] = useState<PortalLab[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [sending, setSending] = useState(false);
  useEffect(() => { void api<{ labs: PortalLab[] }>("/api/portal/labs").then(d => setLabs(d.labs)).catch(() => undefined); }, [reloadKey]);
  const unseen = labs.reduce((n, l) => n + (l.unseen ?? 0), 0);

  return <div className="content core-page flabs-theme">
    <div className="page-heading">
      <div><div className="eyebrow">LAB PORTAL</div><h1>Lab cases</h1><p>Bookings sent to partner labs, and everything the labs send back: status, results and reports.{unseen ? ` ${unseen} case(s) have new lab updates.` : ""}</p></div>
      <Button variant="default" onClick={() => setSending(!sending)}><Send size={15} /> {sending ? "Close" : "Send booking to lab"}</Button>
    </div>
    {sending && <SendCaseForm labs={labs.filter(l => l.active)} onSent={() => { setSending(false); setReloadKey(k => k + 1); }} />}
    <CasesBoard role="healjour_admin" labs={labs} reloadKey={reloadKey} />
  </div>;
}

function SendCaseForm({ labs, onSent }: { labs: PortalLab[]; onSent: () => void }) {
  const [tests, setTests] = useState<CatalogTest[]>([]);
  const [f, setF] = useState({ labId: labs[0]?.id ?? "", name: "", age: "", ageUnit: "year", gender: "", phone: "", priority: "routine", collection: "lab_visit", scheduledAt: "", notes: "" });
  const [codes, setCodes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api<{ tests: CatalogTest[] }>("/api/catalog").then(d => setTests(d.tests.filter(t => t.active))).catch(() => undefined); }, []);
  useEffect(() => { if (!f.labId && labs[0]) setF(prev => ({ ...prev, labId: labs[0].id })); }, [labs]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const send = async () => {
    setBusy(true); setError("");
    try {
      await api("/api/portal/cases", { body: {
        labId: f.labId,
        patient: { name: f.name, age: Number(f.age), ageUnit: f.ageUnit, gender: f.gender, phone: f.phone || undefined },
        tests: tests.filter(t => codes.includes(t.code)).map(t => ({ code: t.code, name: t.name })),
        priority: f.priority, collection: f.collection,
        scheduledAt: f.scheduledAt ? new Date(f.scheduledAt).toISOString() : undefined,
        notes: f.notes || undefined
      } });
      onSent();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not send."); } finally { setBusy(false); }
  };

  if (!labs.length) return <div className="plain-hint"><Building2 size={15} /><span>Add a lab first in <b>Labs &amp; Users</b>.</span></div>;
  return <section className="access-card">
    <div className="access-card-head"><div><h2>Send booking to lab</h2><p>The lab sees it in its portal at once, as a new case.</p></div></div>
    <div className="form-grid">
      <label className="field"><span>Lab *</span><select value={f.labId} onChange={set("labId")}>{labs.map(l => <option key={l.id} value={l.id}>{l.name} ({l.code})</option>)}</select></label>
      <label className="field"><span>Patient name *</span><input value={f.name} onChange={set("name")} /></label>
      <label className="field"><span>Age *</span><input type="number" min="0" value={f.age} onChange={set("age")} /></label>
      <label className="field"><span>Age unit</span><select value={f.ageUnit} onChange={set("ageUnit")}><option value="year">Year</option><option value="month">Month</option><option value="day">Day</option></select></label>
      <label className="field"><span>Gender *</span><select value={f.gender} onChange={set("gender")}><option value="">Choose</option><option value="male">Male</option><option value="female">Female</option><option value="other">Other</option></select></label>
      <label className="field"><span>Phone</span><input value={f.phone} onChange={set("phone")} placeholder="10 digits" /></label>
      <label className="field"><span>Priority</span><select value={f.priority} onChange={set("priority")}><option value="routine">Routine</option><option value="urgent">Urgent</option><option value="stat">STAT</option></select></label>
      <label className="field"><span>Collection</span><select value={f.collection} onChange={set("collection")}><option value="lab_visit">Lab visit</option><option value="home">Home collection</option></select></label>
      <label className="field"><span>Scheduled</span><input type="datetime-local" value={f.scheduledAt} onChange={set("scheduledAt")} /></label>
      <label className="field full"><span>Note for the lab</span><input value={f.notes} onChange={set("notes")} /></label>
    </div>
    <div className="trace-subhead">Tests * ({codes.length} selected)</div>
    <div className="test-pick">{tests.map(t => <label key={t.code} className={codes.includes(t.code) ? "on" : ""}>
      <input type="checkbox" checked={codes.includes(t.code)} onChange={() => setCodes(codes.includes(t.code) ? codes.filter(c => c !== t.code) : [...codes, t.code])} />
      {t.name} <small>{t.code}</small>
    </label>)}</div>
    {error && <div className="access-message error"><X size={16} />{error}</div>}
    <div className="builder-actions">
      <Button variant="default" disabled={busy || !f.labId || f.name.trim().length < 2 || f.age === "" || !f.gender || !codes.length} onClick={() => void send()}><Send size={15} /> {busy ? "Sending…" : "Send to lab"}</Button>
    </div>
  </section>;
}

/** Healjour admin: labs (add, pause) and each lab's users; plus the Healjour admin team. */
export function AdminLabsUsers({ me }: { me: PortalUser }) {
  const [labs, setLabs] = useState<PortalLab[]>([]);
  const [selected, setSelected] = useState<string | "healjour">("healjour");
  const [form, setForm] = useState<{ code: string; name: string; city: string; contactEmail: string } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = async () => {
    try { setLabs((await api<{ labs: PortalLab[] }>("/api/portal/labs")).labs); } catch (e) { setError(e instanceof Error ? e.message : "Could not load labs."); }
  };
  useEffect(() => { void load(); }, []);

  const addLab = async () => {
    if (!form) return;
    setError(""); setNotice("");
    try {
      const d = await api<{ lab: PortalLab }>("/api/portal/labs", { body: form });
      setForm(null); setNotice(`${d.lab.name} added. Now add its first user (lab admin).`);
      await load(); setSelected(d.lab.id);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not add the lab."); }
  };
  const toggle = async (lab: PortalLab) => {
    if (lab.active && !window.confirm(`Pause ${lab.name}? All its users will be signed out and cannot sign in until you resume it.`)) return;
    try { await api(`/api/portal/labs/${lab.id}`, { method: "PUT", body: { active: !lab.active } }); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Could not update the lab."); }
  };
  const lab = labs.find(l => l.id === selected) ?? null;

  return <div className="content core-page flabs-theme">
    <div className="page-heading">
      <div><div className="eyebrow">LAB PORTAL</div><h1>Labs &amp; users</h1><p>Each partner lab gets its own login. Lab users see only their own lab's cases.</p></div>
      {!form && <Button variant="default" onClick={() => setForm({ code: "", name: "", city: "", contactEmail: "" })}><Plus size={15} /> Add lab</Button>}
    </div>
    {form && <section className="access-card">
      <div className="access-card-head"><div><h2>New lab</h2><p>The code appears on cases and logs; it cannot change later.</p></div></div>
      <div className="form-grid">
        <label className="field"><span>Code *</span><input value={form.code} onChange={e => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="LAB-NOIDA-01" /></label>
        <label className="field"><span>Name *</span><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Noida Diagnostics" /></label>
        <label className="field"><span>City</span><input value={form.city} onChange={e => setForm({ ...form, city: e.target.value })} /></label>
        <label className="field"><span>Contact email</span><input type="email" value={form.contactEmail} onChange={e => setForm({ ...form, contactEmail: e.target.value })} /></label>
      </div>
      <div className="builder-actions"><Button variant="default" onClick={() => void addLab()}>Save lab</Button><Button variant="outline" onClick={() => setForm(null)}>Cancel</Button></div>
    </section>}
    {error && <div className="access-message error"><X size={16} />{error}</div>}
    {notice && <div className="access-message success"><CheckCircle2 size={16} />{notice}</div>}

    <div className="labs-grid">
      <button type="button" className={`lab-tile ${selected === "healjour" ? "on" : ""}`} onClick={() => setSelected("healjour")}>
        <b>Healjour team</b><small>Admins of all labs</small>
      </button>
      {labs.map(l => <div key={l.id} className={`lab-tile ${selected === l.id ? "on" : ""} ${l.active ? "" : "paused"}`} role="button" tabIndex={0} onClick={() => setSelected(l.id)} onKeyDown={e => { if (e.key === "Enter") setSelected(l.id); }}>
        <b>{l.name}</b><small>{l.code}{l.city ? ` · ${l.city}` : ""}</small>
        <small>{l.users ?? 0} user(s) · {l.openCases ?? 0} open case(s){l.unseen ? ` · ${l.unseen} new update(s)` : ""}</small>
        <span className={`access-status ${l.active ? "active" : "revoked"}`}>{l.active ? "active" : "paused"}</span>
        <Button variant="outline" size="sm" onClick={e => { e.stopPropagation(); void toggle(l); }}>{l.active ? "Pause" : "Resume"}</Button>
      </div>)}
    </div>
    <TeamPanel me={me} lab={lab} />
  </div>;
}
