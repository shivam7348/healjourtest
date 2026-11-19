import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/PasswordInput";
import { useEffect, useState } from "react";
import { CheckCircle2, KeyRound, Link2, Pencil, Plus, Receipt, RefreshCw, ShieldCheck, Star, Trash2, X, Building2 } from "lucide-react";
import FlabsCorporates from "./FlabsCorporates";
import FlabsMapping from "./FlabsMapping";
import PreBookingForm from "./PreBookingForm";

type Party = { field: "corporateUser" | "referredOrganization" | "referredHospitalOrganization"; id: string } | null;
type Connection = {
  id: string; label: string; clientIdMasked: string; baseUrl: string; branchId: string | null;
  phase: "lead" | "booking"; party: Party; isDefault: boolean;
  secretStorage: "encrypted" | "memory" | "env"; mappedTests: number;
};
type Branch = { branchID: string; name: string };
type FlabsTest = { _id: string; name: string; code: string; cost: number };
type SyncReport = {
  branchId: string; flabsTestCount: number;
  matched: Array<{ healjourCode: string; flabsCode: string; flabsCost: number }>;
  healjourOnly: string[]; flabsOnly: string[];
};

const DEFAULT_URL = "https://v2.flabs.in";
const PARTY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "None (general lab account)" },
  { value: "corporateUser", label: "Corporate account" },
  { value: "referredOrganization", label: "Referring doctor (organization)" },
  { value: "referredHospitalOrganization", label: "Referring hospital (organization)" }
];
const partyText = (p: Party) => (p ? `${PARTY_OPTIONS.find(o => o.value === p.field)?.label ?? p.field}: ${p.id}` : null);

type FormState = {
  id?: string; label: string; clientId: string; clientSecret: string; baseUrl: string;
  branchId: string; phase: "lead" | "booking"; partyField: string; partyId: string; makeDefault: boolean;
};
const blankForm = (): FormState => ({
  label: "", clientId: "", clientSecret: "", baseUrl: DEFAULT_URL, branchId: "", phase: "booking",
  partyField: "", partyId: "", makeDefault: false
});

/**
 * Manages several Flabs accounts: one per lab, one per corporate, one per referral.
 * Each account gets its own branch, pricing and sync. The secret is never shown back.
 */
export default function FlabsConnect({ onChanged }: { onChanged: () => void }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [canPersist, setCanPersist] = useState(true);
  const [form, setForm] = useState<FormState | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reports, setReports] = useState<Record<string, SyncReport>>({});
  const [mappingFor, setMappingFor] = useState<string | null>(null);
  const [prebookFor, setPrebookFor] = useState<string | null>(null);
  const [corpFor, setCorpFor] = useState<string | null>(null);
  const [flabsTests, setFlabsTests] = useState<Record<string, { rows?: FlabsTest[]; error?: string; party?: string | null; filter: string }>>({});

  const viewTests = (c: Connection) => run(async () => {
    const res = await fetch(`/api/flabs/connections/${c.id}/tests`);
    const data = await res.json();
    if (!res.ok) {
      setFlabsTests(t => ({ ...t, [c.id]: { error: data.error || "Flabs did not return tests.", filter: "" } }));
      return;
    }
    setFlabsTests(t => ({ ...t, [c.id]: { rows: data.tests, party: data.party ? `${data.party.field}: ${data.party.id}` : null, filter: "" } }));
  });
  const hideTests = (id: string) => setFlabsTests(t => { const next = { ...t }; delete next[id]; return next; });

  const load = async () => {
    const res = await fetch("/api/flabs/connections");
    if (!res.ok) return;
    const data = await res.json();
    setConnections(data.connections);
    setCanPersist(data.canPersistSecret);
  };
  useEffect(() => { void load(); }, []);

  const run = async (task: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await task(); } catch (e) { setError(e instanceof Error ? e.message : "Something went wrong."); } finally { setBusy(false); }
  };

  const openNew = () => { setForm(blankForm()); setBranches([]); setError(""); setNotice(""); };
  const openEdit = (c: Connection) => {
    setForm({
      id: c.id, label: c.label, clientId: "", clientSecret: "", baseUrl: c.baseUrl,
      branchId: c.branchId ?? "", phase: c.phase, partyField: c.party?.field ?? "", partyId: c.party?.id ?? "", makeDefault: c.isDefault
    });
    setBranches([]); setError(""); setNotice("");
  };

  const partyPayload = (f: FormState) => (f.partyField && f.partyId.trim() ? { field: f.partyField, id: f.partyId.trim() } : undefined);

  // Step 1 for new accounts: check the login and fetch its branches. Edits skip this and keep the saved login.
  const checkCredentials = () => run(async () => {
    if (!form) return;
    const res = await fetch("/api/flabs/test", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: form.clientId, clientSecret: form.clientSecret, baseUrl: form.baseUrl })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "Could not connect to Flabs.");
    setBranches(data.branches);
    setForm({ ...form, branchId: data.branches[0]?.branchID ?? "", label: form.label || `Flabs ${data.branches[0]?.name ?? form.clientId}` });
    setNotice(data.branches.length ? "Login is OK. Choose a branch and save." : "Login is OK, but no branch was found for this account.");
  });

  const save = () => run(async () => {
    if (!form) return;
    const isEdit = Boolean(form.id);
    const url = isEdit ? `/api/flabs/connections/${form.id}` : "/api/flabs/connections";
    const res = await fetch(url, {
      method: isEdit ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: form.label || form.clientId, clientId: form.clientId || undefined,
        clientSecret: form.clientSecret || undefined, baseUrl: form.baseUrl, branchId: form.branchId,
        phase: form.phase, party: partyPayload(form), makeDefault: form.makeDefault
      })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "Could not save.");
    setNotice(data.message);
    setForm(null);
    await load();
    onChanged();
  });

  const remove = (c: Connection) => {
    if (!window.confirm(`"${c.label}" remove? Orders for this account will no longer be sent.`)) return;
    void run(async () => {
      const res = await fetch(`/api/flabs/connections/${c.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not remove.");
      setNotice(`"${c.label}" removed.`);
      await load();
      onChanged();
    });
  };

  const makeDefault = (c: Connection) => run(async () => {
    const res = await fetch(`/api/flabs/connections/${c.id}/default`, { method: "POST" });
    if (!res.ok) throw new Error("Could not set as default.");
    await load();
  });

  const registerWebhooks = (c: Connection) => run(async () => {
    const res = await fetch(`/api/flabs/connections/${c.id}/webhooks`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({})
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "Webhook registration failed.");
    setNotice(`${data.message} Flabs will post events to: ${data.endpoint}`);
  });

  const sync = (c: Connection) => run(async () => {
    const res = await fetch(`/api/flabs/connections/${c.id}/sync`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Sync fail hua.");
    setReports(r => ({ ...r, [c.id]: data }));
    setNotice(`"${c.label}": ${data.matched.length} test(s) matched.`);
    await load();
  });

  const formReady = form && (form.id || (form.clientId.trim().length >= 3 && form.clientSecret.trim().length >= 3));
  const canSave = Boolean(form && form.branchId.trim() && (branches.length > 0 || form.id));

  return <section className="access-card flabs-theme">
    <div className="access-card-head">
      <div><h2>Flabs CRM accounts</h2><p>Connect lab, corporate and referral accounts here. Each account has its own branch and rates.</p></div>
      <span className={`access-status ${connections.length ? "approved" : "pending"}`}>{connections.length} connected</span>
    </div>

    {!canPersist && <div className="access-message error"><X size={16} />FLABS_SECRET_KEY is not set on the server. Secrets will only stay in server memory and must be entered again after a restart.</div>}

    <div className="flabs-accounts">
      {connections.map(c => <div key={c.id} className={`flabs-account ${c.isDefault ? "is-default" : ""}`}>
        <div className="flabs-account-head">
          <div>
            <b>{c.label}{c.isDefault && <span className="core-layer-chip passed account-chip">default</span>}</b>
            <small>{c.clientIdMasked} · branch {c.branchId ?? "—"} · {c.phase}{c.party ? ` · ${partyText(c.party)}` : ""}</small>
          </div>
          <span className="trace-ms">{c.mappedTests} test mapped</span>
        </div>
        <div className="credential-actions">
          <Button variant="default" size="sm" disabled={busy} onClick={() => setPrebookFor(prebookFor === c.id ? null : c.id)}><Receipt size={13} /> {prebookFor === c.id ? "Close pre-booking" : "Pre-booking"}</Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setCorpFor(corpFor === c.id ? null : c.id)}><Building2 size={13} /> {corpFor === c.id ? "Close corporates" : "Corporates"}</Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void sync(c)}><RefreshCw size={13} /> Sync</Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => flabsTests[c.id] ? hideTests(c.id) : void viewTests(c)}>{flabsTests[c.id] ? "Hide Flabs tests" : "View Flabs tests"}</Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setMappingFor(mappingFor === c.id ? null : c.id)}>{mappingFor === c.id ? "Close mapping" : "Map tests"}</Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void registerWebhooks(c)}>Register webhooks</Button>
          {!c.isDefault && <Button variant="outline" size="sm" disabled={busy} onClick={() => void makeDefault(c)}><Star size={13} /> Set as default</Button>}
          <Button variant="outline" size="sm" disabled={busy} onClick={() => openEdit(c)}><Pencil size={13} /> Edit</Button>
          <Button variant="destructive" size="sm" className="account-delete" disabled={busy} onClick={() => remove(c)}><Trash2 size={13} /> Delete</Button>
        </div>
        {prebookFor === c.id && <PreBookingForm connectionId={c.id} embedded />}
        {corpFor === c.id && <FlabsCorporates connectionId={c.id} />}
        {mappingFor === c.id && <FlabsMapping connectionId={c.id} label={c.label} onChanged={() => void load()} onClose={() => setMappingFor(null)} />}
        {flabsTests[c.id] && <div className="flabs-tests">
          {flabsTests[c.id].error && (/only with a corporate/.test(flabsTests[c.id].error!)
            ? <div className="plain-hint"><span>{flabsTests[c.id].error}</span></div>
            : <div className="access-message error"><X size={16} />{flabsTests[c.id].error}</div>)}
          {flabsTests[c.id].rows && <>
            <div className="trace-subhead">Flabs tests ({flabsTests[c.id].rows!.length}){flabsTests[c.id].party ? ` · pricing for ${flabsTests[c.id].party}` : " · standard branch pricing"}</div>
            <input className="flabs-tests-search" placeholder="Search by name or code" value={flabsTests[c.id].filter} onChange={e => setFlabsTests(t => ({ ...t, [c.id]: { ...t[c.id], filter: e.target.value } }))} />
            <div className="access-table-wrap"><table className="access-table">
              <thead><tr><th>NAME</th><th>CODE</th><th>FLABS TEST ID</th><th>COST</th></tr></thead>
              <tbody>{flabsTests[c.id].rows!
                .filter(t => { const q = flabsTests[c.id].filter.trim().toLowerCase(); return !q || t.name.toLowerCase().includes(q) || (t.code ?? "").toLowerCase().includes(q); })
                .map(t => <tr key={t._id}><td>{t.name}</td><td><code>{t.code || "—"}</code></td><td><code>{t._id}</code></td><td>₹{t.cost}</td></tr>)}
              </tbody>
            </table></div>
          </>}
        </div>}
        {reports[c.id] && <div className="sync-report">
          <div className="trace-subhead">Matched ({reports[c.id].matched.length})</div>
          <p className="delivery-reason">{reports[c.id].matched.map(m => `${m.healjourCode} → ${m.flabsCode} ₹${m.flabsCost}`).join(" · ") || "No test matched."}</p>
          {reports[c.id].healjourOnly.length > 0 && <p className="delivery-reason">Not in Flabs: {reports[c.id].healjourOnly.join(", ")}</p>}
        </div>}
      </div>)}
      {connections.length === 0 && !form && <p className="delivery-reason">No account is connected yet.</p>}
    </div>

    {!form && <div className="credential-actions">
      <Button variant="default" onClick={openNew}><Plus size={15} /> Add new Flabs account</Button>
    </div>}

    {form && <div className="flabs-form">
      <div className="trace-subhead">{form.id ? `Edit "${form.label}"` : "New account"}</div>
      <div className="form-grid">
        <label className="field"><span>Name (label) *</span><input value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} placeholder="Lab - Noida / Corporate - Infosys" /></label>
        <label className="field"><span>Account type</span>
          <select value={form.partyField} onChange={e => setForm({ ...form, partyField: e.target.value, partyId: e.target.value ? form.partyId : "" })}>
            {PARTY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        {form.partyField && <label className="field full"><span>{PARTY_OPTIONS.find(o => o.value === form.partyField)?.label} ID *</span><input value={form.partyId} onChange={e => setForm({ ...form, partyId: e.target.value })} placeholder="Corporate / organization ID from Flabs" /><small>Is account ke saare leads isi party se jayenge, aur rates bhi isi ke hisaab se honge.</small></label>}
        <label className="field"><span>Client ID {form.id ? "(leave empty to keep the same)" : "*"}</span><input value={form.clientId} onChange={e => setForm({ ...form, clientId: e.target.value })} placeholder={form.id ? "" : "Client ID from Flabs"} autoComplete="off" /></label>
        <label className="field"><span>Client Secret {form.id ? "(leave empty to keep the same)" : "*"}</span><PasswordInput value={form.clientSecret} onChange={e => setForm({ ...form, clientSecret: e.target.value })} placeholder="••••••••" autoComplete="new-password" /></label>
        <label className="field full"><span>Server URL</span><input value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })} /></label>
      </div>

      {!form.id && <div className="credential-actions">
        <Button variant="outline" disabled={busy || !formReady} onClick={() => void checkCredentials()}><KeyRound size={15} /> 1. Check login</Button>
      </div>}

      {(branches.length > 0 || form.id) && <div className="form-grid" style={{ marginTop: 14 }}>
        {branches.length > 0
          ? <label className="field"><span>Branch (Flabs) *</span>
              <select value={form.branchId} onChange={e => setForm({ ...form, branchId: e.target.value })}>
                {branches.map(b => <option key={b.branchID} value={b.branchID}>{b.name} ({b.branchID})</option>)}
              </select>
            </label>
          : <label className="field"><span>Branch ID *</span><input value={form.branchId} onChange={e => setForm({ ...form, branchId: e.target.value })} /></label>}
        <label className="field"><span>How to send</span>
          <select value={form.phase} onChange={e => setForm({ ...form, phase: e.target.value as "lead" | "booking" })}>
            <option value="booking">Booking (confirmed)</option>
            <option value="lead">Lead (in funnel)</option>
          </select>
        </label>
        <label className="mini-check full"><input type="checkbox" checked={form.makeDefault} onChange={e => setForm({ ...form, makeDefault: e.target.checked })} /><span>Make this the default account</span></label>
      </div>}

      <div className="credential-actions">
        <Button variant="default" disabled={busy || !canSave || (form.partyField !== "" && !form.partyId.trim())} onClick={() => void save()}><ShieldCheck size={15} /> {form.id ? "Save" : "2. Save"}</Button>
        <Button variant="outline" disabled={busy} onClick={() => setForm(null)}>Cancel</Button>
      </div>
    </div>}

    {error && <div className="access-message error"><X size={16} />{error}<Button className="h-auto" variant="ghost" onClick={() => setError("")}>Dismiss</Button></div>}
    {notice && <div className="access-message success"><CheckCircle2 size={16} />{notice}<Button className="h-auto" variant="ghost" onClick={() => setNotice("")}>Dismiss</Button></div>}
    <p className="delivery-reason"><Link2 size={12} /> New orders go to the default account, or to every account you select.</p>
  </section>;
}
