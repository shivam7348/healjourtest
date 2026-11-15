import { useEffect, useState } from "react";
import { CheckCircle2, Plus, Receipt, RefreshCw, Save, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PickerItem } from "./FlabsBookingForm";

type Connection = { id: string; label: string; branchId: string | null; isDefault: boolean; party: { field: string; id: string } | null };
type PackageOption = PickerItem & { testCodes: string[] };
type SyncStatus = { lastSyncedAt: string | null; error: string | null; ranNow: boolean };
type Options = { connection: { id: string; label: string; branchId: string | null }; sync?: SyncStatus; tests: PickerItem[]; packages: PackageOption[] };
type PackageWithTests = { package_name: string; tests: string };
type Referral = { id?: string; name: string; flabsId: string };
type Settings = {
  leadSources: string[]; rateListTypes: string[]; doctors: Referral[]; hospitals: Referral[];
  autoPrebooking?: boolean; defaultLeadSource?: string; defaultRateListType?: string; updatedAt?: string;
};
type Result = {
  ok: boolean; message?: string; error?: string; integratorId?: string; preBookingID?: string;
  mappedTests?: string[]; unmappedTests?: string[]; mappedPackages?: string[]; unmappedPackages?: string[];
};

const EMPTY_SETTINGS: Settings = { leadSources: [], rateListTypes: [], doctors: [], hospitals: [] };

const timeAgo = (iso: string) => {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
};

/** Pre-booking for Flabs billing (POST /client/billing/create). Goes to lab accounts only, never corporate ones. */
/**
 * `connectionId` + `embedded`: shown inside one Flabs account card (Test Catalog), fixed to that account,
 * without the page heading and account picker.
 */
export default function PreBookingForm({ connectionId: fixedId, embedded = false }: { connectionId?: string; embedded?: boolean } = {}) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [options, setOptions] = useState<Options | null>(null);
  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS);
  const [f, setF] = useState({
    first_name: "", last_name: "", gender: "", age: "", age_type: "year",
    integrator_id: "", lead_source: "", barCode: "", doctor: "", hospital: "", rate_list_type: ""
  });
  const set = (key: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [key]: e.target.value });

  const [testCodes, setTestCodes] = useState<string[]>([]);
  const [packageCodes, setPackageCodes] = useState<string[]>([]);
  const [extraTests, setExtraTests] = useState<string[]>([]);
  const [extraPackages, setExtraPackages] = useState<string[]>([]);
  const [packagesWithTests, setPackagesWithTests] = useState<PackageWithTests[]>([]);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState("");
  const [flabsCatalog, setFlabsCatalog] = useState<FlabsCatalog | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  // Corporate and referral accounts are not used for pre-bookings: only lab accounts are offered.
  const labAccounts = connections.filter(c => !c.party);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/flabs/connections");
      if (!res.ok) return;
      const data = await res.json();
      const all: Connection[] = data.connections;
      setConnections(all);
      const labs = all.filter(c => !c.party);
      const def = (fixedId ? labs.find(c => c.id === fixedId) : undefined) ?? labs.find(c => c.isDefault) ?? labs[0];
      if (def) setConnectionId(def.id);
    })();
  }, [fixedId]);

  const loadOptions = async (id: string) => {
    const res = await fetch(`/api/flabs/booking-options?connectionId=${encodeURIComponent(id)}`);
    if (res.ok) setOptions(await res.json());
  };
  const loadSettings = async (id: string) => {
    const res = await fetch(`/api/flabs/connections/${encodeURIComponent(id)}/prebooking-settings`);
    if (res.ok) setSettings((await res.json()).settings);
  };

  useEffect(() => {
    if (!connectionId) return;
    void loadOptions(connectionId);
    void loadSettings(connectionId);
    setTestCodes([]); setPackageCodes([]); setSyncNote(""); setFlabsCatalog(null);
    void fetch(`/api/flabs/connections/${encodeURIComponent(connectionId)}/flabs-catalog`).then(r => r.json()).then(setFlabsCatalog).catch(() => undefined);
    setF(prev => ({ ...prev, lead_source: "", rate_list_type: "", doctor: "", hospital: "" }));
  }, [connectionId]);

  // A single configured value is picked automatically.
  useEffect(() => {
    const lead = settings.defaultLeadSource ?? (settings.leadSources.length === 1 ? settings.leadSources[0] : "");
    setF(prev => ({ ...prev, lead_source: prev.lead_source || lead, rate_list_type: prev.rate_list_type || settings.defaultRateListType || "" }));
  }, [settings]);

  const syncTests = async () => {
    setSyncing(true); setSyncNote("");
    try {
      const res = await fetch(`/api/flabs/connections/${encodeURIComponent(connectionId)}/sync`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || "Sync failed.");
      await loadOptions(connectionId);
      setSyncNote(`Synced now: ${data.matched?.length ?? 0} test(s) matched by code; ${data.healjourOnly?.length ?? 0} Healjour test(s) not found in this lab's Flabs list.`);
    } catch (e) {
      setSyncNote(e instanceof Error ? e.message : "Sync failed.");
    } finally {
      setSyncing(false);
    }
  };

  const cleanList = (list: string[]) => list.map(s => s.trim()).filter(Boolean);
  const cleanPackages = packagesWithTests
    .map(p => ({ package_name: p.package_name.trim(), tests: cleanList(p.tests.split(",")) }))
    .filter(p => p.package_name && p.tests.length);
  const serviceCount = testCodes.length + packageCodes.length + cleanList(extraTests).length + cleanList(extraPackages).length + cleanPackages.length;
  const canSubmit = Boolean(connectionId && f.first_name.trim() && f.gender && f.age !== "" && Number.isInteger(Number(f.age)) && f.lead_source.trim() && serviceCount > 0);

  const chosenTests = (options?.tests ?? []).filter(t => testCodes.includes(t.code));
  const chosenPackages = (options?.packages ?? []).filter(p => packageCodes.includes(p.code));
  const unmappedChosen = [...chosenTests, ...chosenPackages].filter(i => !i.mapped);
  const mappedCount = (options?.tests ?? []).filter(t => t.mapped).length;

  const submit = async () => {
    setBusy(true); setError(""); setResult(null);
    try {
      const body = {
        connectionId,
        integrator_id: f.integrator_id || undefined,
        lead_source: f.lead_source,
        first_name: f.first_name,
        last_name: f.last_name || undefined,
        gender: f.gender,
        age: Number(f.age),
        age_type: f.age_type,
        barCode: f.barCode || undefined,
        doctor: f.doctor || undefined,
        hospital: f.hospital || undefined,
        rate_list_type: f.rate_list_type || undefined,
        tests: testCodes.map(code => ({ code })),
        packages: packageCodes.map(code => ({ code })),
        unmappedTests: cleanList(extraTests),
        unmappedPackages: cleanList(extraPackages),
        unmappedPackagesWithTests: cleanPackages
      };
      const res = await fetch("/api/flabs/prebookings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data: Result = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Pre-booking was not sent.");
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Pre-booking was not sent.");
    } finally {
      setBusy(false);
    }
  };

  if (connections.length === 0) {
    return <div className="content">
      <div className="empty-state"><b>First connect a Flabs account</b><p>Go to Test Catalog → Flabs CRM accounts and add the lab account. Then you can create pre-bookings here.</p></div>
    </div>;
  }
  if (labAccounts.length === 0) {
    return <div className="content">
      <div className="empty-state"><b>No lab account connected</b><p>Pre-bookings go to the lab account only. The connected accounts are all corporate or referral accounts. Add the lab account (without a party) in Test Catalog → Flabs CRM accounts.</p></div>
    </div>;
  }

  return <div className={embedded ? "prebook-embedded flabs-theme" : "content core-page flabs-theme"}>
    {!embedded && <div className="page-heading">
      <div>
        <div className="eyebrow">ORDERS & BOOKINGS</div>
        <h1>New pre-booking in Flabs</h1>
        <p>A pre-booking starts the billing workflow in Flabs. Flabs returns a pre-booking ID to track it.</p>
      </div>
    </div>}
    {embedded && <div className="trace-subhead">Pre-booking (POST /client/billing/create) · no corporate needed</div>}

    <div className="plain-hint">
      <RefreshCw size={15} />
      <span>
        <b>Automatic:</b> lab account connected ({labAccounts.find(c => c.id === connectionId)?.label ?? "—"}) ·
        {" "}tests {options?.sync?.lastSyncedAt ? `synced with Flabs ${timeAgo(options.sync.lastSyncedAt)}` : "not synced yet"}{options?.sync?.error ? ` (last try failed: ${options.sync.error})` : ""} ·
        {" "}auto pre-booking {settings.autoPrebooking ? <b>ON</b> : "off"}{settings.autoPrebooking ? ` — every Healjour booking sent to this lab also creates a pre-booking (lead source ${settings.defaultLeadSource}).` : " — switch it on in Pre-booking setup below."}
      </span>
    </div>

    <div className="booking-layout">
      <div className="booking-main">
        {!embedded && <section className="access-card">
          <div className="access-card-head"><div><h2>1. Lab account</h2><p>Pre-bookings go to a lab account. Corporate and referral accounts are not used here.</p></div></div>
          <div className="form-grid">
            <label className="field"><span>Flabs lab account *</span>
              <select value={connectionId} onChange={e => setConnectionId(e.target.value)}>
                {labAccounts.map(c => <option key={c.id} value={c.id}>{c.label}{c.isDefault ? " (default)" : ""}</option>)}
              </select>
              {connections.length > labAccounts.length && <small>{connections.length - labAccounts.length} corporate/referral account(s) hidden.</small>}
            </label>
            <div className="field"><span>Lab ID (labID)</span>{options?.connection.branchId ? <code>{options.connection.branchId}</code> : <small>No lab selected on this account. Edit it in Test Catalog.</small>}</div>
          </div>
        </section>}

        <section className="access-card">
          <div className="access-card-head"><div><h2>{embedded ? 1 : 2}. Patient details</h2><p>Flabs needs first name, gender, age and age unit.</p></div></div>
          <div className="form-grid">
            <label className="field"><span>First name *</span><input value={f.first_name} onChange={set("first_name")} /></label>
            <label className="field"><span>Last name</span><input value={f.last_name} onChange={set("last_name")} /></label>
            <label className="field"><span>Gender *</span>
              <select value={f.gender} onChange={set("gender")}><option value="">Choose</option><option value="male">Male</option><option value="female">Female</option><option value="other">Other</option></select>
            </label>
            <label className="field"><span>Age *</span><input type="number" min="0" step="1" value={f.age} onChange={set("age")} /></label>
            <label className="field"><span>Age type *</span>
              <select value={f.age_type} onChange={set("age_type")}><option value="year">Year</option><option value="month">Month</option><option value="day">Day</option></select>
            </label>
          </div>
        </section>

        <section className="access-card">
          <div className="access-card-head"><div><h2>{embedded ? 2 : 3}. Tracking and billing</h2><p>Lead source, rate list, doctor and hospital come from the Pre-booking setup below.</p></div></div>
          <div className="form-grid">
            <label className="field"><span>Lead source *</span>
              {settings.leadSources.length
                ? <select value={f.lead_source} onChange={set("lead_source")}><option value="">Choose</option>{settings.leadSources.map(s => <option key={s} value={s}>{s}</option>)}</select>
                : <><input value={f.lead_source} onChange={set("lead_source")} placeholder="Value given by Flabs" /><small>Add the allowed lead sources in Pre-booking setup to pick from a list.</small></>}
            </label>
            <label className="field"><span>Rate list type</span>
              {settings.rateListTypes.length
                ? <select value={f.rate_list_type} onChange={set("rate_list_type")}><option value="">Default</option>{settings.rateListTypes.map(s => <option key={s} value={s}>{s}</option>)}</select>
                : <><input value={f.rate_list_type} onChange={set("rate_list_type")} placeholder="Optional" /><small>Optional. Add rate lists in Pre-booking setup to pick from a list.</small></>}
            </label>
            <label className="field"><span>Referring doctor</span>
              <select value={f.doctor} onChange={set("doctor")} disabled={!settings.doctors.length}>
                <option value="">{settings.doctors.length ? "None" : "No doctors mapped yet"}</option>
                {settings.doctors.map(d => <option key={d.flabsId} value={d.flabsId}>{d.name}</option>)}
              </select>
            </label>
            <label className="field"><span>Referring hospital</span>
              <select value={f.hospital} onChange={set("hospital")} disabled={!settings.hospitals.length}>
                <option value="">{settings.hospitals.length ? "None" : "No hospitals mapped yet"}</option>
                {settings.hospitals.map(h => <option key={h.flabsId} value={h.flabsId}>{h.name}</option>)}
              </select>
            </label>
            <label className="field"><span>Integrator ID</span><input value={f.integrator_id} onChange={set("integrator_id")} placeholder="Left empty: created automatically" /><small>Your own ID. Flabs sends it back in webhooks.</small></label>
            <label className="field"><span>Barcode</span><input value={f.barCode} onChange={set("barCode")} /><small>Optional. Must be unique in Flabs.</small></label>
          </div>
        </section>

        <section className="access-card">
          <div className="access-card-head">
            <div><h2>{embedded ? 3 : 4}. Tests and packages</h2><p>Mapped items go by Flabs ID. Unmapped items go by name and Flabs has to match them by hand.</p></div>
            <Button variant="outline" size="sm" disabled={syncing || !connectionId} onClick={() => void syncTests()}><RefreshCw size={14} className={syncing ? "spin" : ""} /> {syncing ? "Syncing…" : "Sync now"}</Button>
          </div>
          <div className="plain-hint">
            <span>{mappedCount} of {options?.tests.length ?? 0} tests and {(options?.packages ?? []).filter(p => p.mapped).length} of {options?.packages.length ?? 0} packages are mapped to this lab in Flabs. Click <b>Map</b> on any row to link it to its Flabs {flabsCatalog?.available === false ? "ID (Flabs does not list them for this account, so type the ID Flabs gave you)" : "test or package"}.{syncNote ? ` ${syncNote}` : ""}</span>
          </div>
          <CatalogChecklist label="Tests" kind="test" connectionId={connectionId} flabsList={flabsCatalog} onMapped={() => void loadOptions(connectionId)}
            items={options?.tests ?? []} selected={testCodes} onChange={setTestCodes} />
          <CatalogChecklist label="Packages" kind="package" connectionId={connectionId} flabsList={flabsCatalog} onMapped={() => void loadOptions(connectionId)}
            items={options?.packages ?? []} selected={packageCodes} onChange={setPackageCodes}
            detail={p => {
              const codes = (p as PackageOption).testCodes ?? [];
              const names = codes.map(code => options?.tests.find(t => t.code === code)?.name ?? code);
              return names.length ? `Includes: ${names.join(", ")}` : "";
            }} />
          {unmappedChosen.length > 0 && <div className="booking-hint-box">Not mapped, will go by name: {unmappedChosen.map(i => i.name).join(", ")}. Map them first if Flabs should bill them automatically.</div>}
          <NameList title="Other tests (by name)" values={extraTests} setValues={setExtraTests} />
          <NameList title="Other packages (by name)" values={extraPackages} setValues={setExtraPackages} />
          <div className="rows-block">
            <div className="trace-subhead">Packages with their tests (by name)</div>
            {packagesWithTests.map((p, i) => <div key={i} className="form-grid" style={{ marginBottom: 8 }}>
              <label className="field"><span>Package name</span><input value={p.package_name} onChange={e => setPackagesWithTests(packagesWithTests.map((x, j) => j === i ? { ...x, package_name: e.target.value } : x))} /></label>
              <label className="field"><span>Tests (comma separated)</span><input value={p.tests} onChange={e => setPackagesWithTests(packagesWithTests.map((x, j) => j === i ? { ...x, tests: e.target.value } : x))} placeholder="Test 1, Test 2" /></label>
            </div>)}
            <Button variant="outline" size="sm" onClick={() => setPackagesWithTests([...packagesWithTests, { package_name: "", tests: "" }])}><Plus size={14} /> Add package</Button>
          </div>
        </section>

        <PrebookingSetup connectionId={connectionId} settings={settings} onSaved={setSettings} />
      </div>

      <aside className="booking-sidebar">
        <div className="access-card">
          <div className="access-card-head"><div><h2>Summary</h2><p>Quick check before sending.</p></div></div>
          <div className="booking-summary-list">
            <div><span>Patient</span><strong>{f.first_name || "Not added"}{f.last_name ? ` ${f.last_name}` : ""}</strong></div>
            <div><span>Gender / age</span><strong>{f.gender || "—"} · {f.age ? `${f.age} ${f.age_type}` : "—"}</strong></div>
            <div><span>Lead source</span><strong>{f.lead_source || "Not added"}</strong></div>
            <div><span>Doctor / hospital</span><strong>{settings.doctors.find(d => d.flabsId === f.doctor)?.name ?? "—"} · {settings.hospitals.find(h => h.flabsId === f.hospital)?.name ?? "—"}</strong></div>
            <div><span>Services</span><strong>{serviceCount} selected{unmappedChosen.length ? ` (${unmappedChosen.length} not mapped)` : ""}</strong></div>
          </div>
          {!canSubmit && <div className="booking-hint-box">Needs: lab account, first name, gender, whole-number age, lead source, and at least one test or package.</div>}
        </div>
      </aside>
    </div>

    {error && <div className="access-message error"><X size={16} />{error}<Button className="h-auto" variant="ghost" onClick={() => setError("")}>Dismiss</Button></div>}
    {result?.ok && <div className="access-message success"><CheckCircle2 size={16} />{result.message}
      {result.preBookingID ? ` Pre-booking ID: ${result.preBookingID}` : ""} · Integrator ID: {result.integratorId}
      {(result.unmappedTests?.length || result.unmappedPackages?.length) ? <> · Sent by name: {[...(result.unmappedTests ?? []), ...(result.unmappedPackages ?? [])].join(", ")}</> : null}
    </div>}

    <div className="booking-actionbar">
      <div><small>Services</small><b>{serviceCount}</b></div>
      <Button variant="default" disabled={busy || !canSubmit} onClick={() => void submit()}><Receipt size={15} /> {busy ? "Sending…" : "Create pre-booking"}</Button>
    </div>
  </div>;
}

/** Pre-booking setup for one lab account: the values Flabs gave this lab, mapped once and picked from lists afterwards. */
function PrebookingSetup({ connectionId, settings, onSaved }: { connectionId: string; settings: Settings; onSaved: (s: Settings) => void }) {
  const [open, setOpen] = useState(false);
  const [leadSources, setLeadSources] = useState("");
  const [rateLists, setRateLists] = useState("");
  const [doctors, setDoctors] = useState<Referral[]>([]);
  const [hospitals, setHospitals] = useState<Referral[]>([]);
  const [autoOn, setAutoOn] = useState(false);
  const [defaultLead, setDefaultLead] = useState("");
  const [defaultRate, setDefaultRate] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setLeadSources(settings.leadSources.join(", "));
    setRateLists(settings.rateListTypes.join(", "));
    setDoctors(settings.doctors);
    setHospitals(settings.hospitals);
    setAutoOn(Boolean(settings.autoPrebooking));
    setDefaultLead(settings.defaultLeadSource ?? "");
    setDefaultRate(settings.defaultRateListType ?? "");
  }, [settings]);

  const split = (text: string) => text.split(",").map(s => s.trim()).filter(Boolean);
  const save = async () => {
    setBusy(true); setMessage(""); setError("");
    try {
      const body = {
        leadSources: split(leadSources),
        rateListTypes: split(rateLists),
        doctors: doctors.filter(d => d.name.trim() && d.flabsId.trim()).map(({ name, flabsId }) => ({ name, flabsId })),
        hospitals: hospitals.filter(h => h.name.trim() && h.flabsId.trim()).map(({ name, flabsId }) => ({ name, flabsId })),
        autoPrebooking: autoOn,
        defaultLeadSource: defaultLead.trim() || undefined,
        defaultRateListType: defaultRate.trim() || undefined
      };
      const res = await fetch(`/api/flabs/connections/${encodeURIComponent(connectionId)}/prebooking-settings`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Could not save the setup.");
      onSaved(data.settings);
      setMessage("Pre-booking setup saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the setup.");
    } finally {
      setBusy(false);
    }
  };

  const total = settings.leadSources.length + settings.rateListTypes.length + settings.doctors.length + settings.hospitals.length;

  return <section className="access-card">
    <div className="access-card-head">
      <div><h2>Pre-booking setup for this lab</h2><p>Enter once the values Flabs gave this lab. The form above then offers them as lists. {total ? `${settings.doctors.length} doctor(s), ${settings.hospitals.length} hospital(s), ${settings.leadSources.length} lead source(s) mapped.` : "Nothing set up yet."}</p></div>
      <Button variant="outline" size="sm" onClick={() => setOpen(!open)}>{open ? "Close" : "Edit setup"}</Button>
    </div>
    {open && <>
      <div className="form-grid">
        <label className="field"><span>Lead sources (comma separated)</span><input value={leadSources} onChange={e => setLeadSources(e.target.value)} placeholder="e.g. healjour, website" /><small>Exactly as Flabs gave them. Only these will be accepted.</small></label>
        <label className="field"><span>Rate list types (comma separated)</span><input value={rateLists} onChange={e => setRateLists(e.target.value)} placeholder="Optional" /></label>
      </div>
      <div className="rows-block">
        <div className="trace-subhead">Auto pre-booking</div>
        <label className="auto-toggle">
          <input type="checkbox" checked={autoOn} onChange={e => setAutoOn(e.target.checked)} />
          <span>Create a Flabs pre-booking automatically for every Healjour booking sent to this lab</span>
        </label>
        <div className="form-grid">
          <label className="field"><span>Default lead source{autoOn ? " *" : ""}</span>
            {split(leadSources).length
              ? <select value={defaultLead} onChange={e => setDefaultLead(e.target.value)}><option value="">Choose</option>{split(leadSources).map(v => <option key={v} value={v}>{v}</option>)}</select>
              : <input value={defaultLead} onChange={e => setDefaultLead(e.target.value)} placeholder="e.g. healjour" />}
            <small>A booking has no lead source, so this one is used. Also pre-fills the form above.</small>
          </label>
          <label className="field"><span>Default rate list type</span>
            {split(rateLists).length
              ? <select value={defaultRate} onChange={e => setDefaultRate(e.target.value)}><option value="">None</option>{split(rateLists).map(v => <option key={v} value={v}>{v}</option>)}</select>
              : <input value={defaultRate} onChange={e => setDefaultRate(e.target.value)} placeholder="Optional" />}
          </label>
        </div>
        <small className="muted">Gender is required by Flabs: bookings without a gender are skipped and shown in Logs. A referring doctor/hospital is passed on only if it is in the mapped lists below.</small>
      </div>
      <ReferralTable title="Referring doctors" hint="Healjour name → Flabs doctor ID" rows={doctors} setRows={setDoctors} />
      <ReferralTable title="Referring hospitals" hint="Healjour name → Flabs hospital ID" rows={hospitals} setRows={setHospitals} />
      {message && <div className="access-message success">{message}</div>}
      {error && <div className="access-message error">{error}</div>}
      <Button variant="default" size="sm" disabled={busy || !connectionId} onClick={() => void save()}><Save size={14} /> {busy ? "Saving…" : "Save setup"}</Button>
    </>}
  </section>;
}

function ReferralTable({ title, hint, rows, setRows }: { title: string; hint: string; rows: Referral[]; setRows: (r: Referral[]) => void }) {
  const update = (i: number, key: "name" | "flabsId", value: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
  return <div className="rows-block">
    <div className="trace-subhead">{title} <small className="muted">({hint})</small></div>
    {rows.map((r, i) => <div key={i} className="form-grid referral-row">
      <label className="field"><span>Name in Healjour</span><input value={r.name} onChange={e => update(i, "name", e.target.value)} placeholder="Dr. A. Kumar" /></label>
      <label className="field"><span>Flabs ID</span><input value={r.flabsId} onChange={e => update(i, "flabsId", e.target.value)} placeholder="ID given by Flabs" /></label>
      <Button variant="ghost" size="sm" aria-label={`Remove ${r.name || "row"}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 size={14} /></Button>
    </div>)}
    <Button variant="outline" size="sm" onClick={() => setRows([...rows, { name: "", flabsId: "" }])}><Plus size={14} /> Add</Button>
  </div>;
}

type FlabsItem = { _id: string; name: string; code: string; cost: number };
type FlabsCatalog = { available: boolean; tests: FlabsItem[]; packages: FlabsItem[]; error?: string };
type MapItem = PickerItem & { flabsId?: string | null; flabsName?: string | null };

/**
 * Every test or package as a ticked list: name, code, price, and its Flabs mapping.
 * "Map" links a row to a Flabs test/package: picked from Flabs' list, or typed when Flabs does not list them.
 */
function CatalogChecklist({ label, kind, connectionId, flabsList, onMapped, items, selected, onChange, detail }: {
  label: string; kind: "test" | "package"; connectionId: string; flabsList: FlabsCatalog | null; onMapped: () => void;
  items: MapItem[]; selected: string[]; onChange: (codes: string[]) => void; detail?: (item: PickerItem) => string;
}) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  const shown = q ? items.filter(i => i.name.toLowerCase().includes(q) || i.code.toLowerCase().includes(q)) : items;
  const toggle = (code: string) => onChange(selected.includes(code) ? selected.filter(c => c !== code) : [...selected, code]);
  const total = items.filter(i => selected.includes(i.code)).reduce((sum, i) => sum + (i.price || 0), 0);
  const mapped = items.filter(i => i.mapped).length;

  return <div className="catalog-checklist">
    <div className="catalog-checklist-head">
      <div className="trace-subhead">{label} <small className="muted">({items.length} available · {mapped} mapped{selected.length ? ` · ${selected.length} selected${total ? ` · ₹${total}` : ""}` : ""})</small></div>
      {items.length > 6 && <input className="list-search" placeholder={`Search ${label.toLowerCase()}`} value={query} onChange={e => setQuery(e.target.value)} />}
    </div>
    {items.length === 0 && <p className="delivery-reason">No {label.toLowerCase()} in the Healjour catalog yet. Add them in Test Catalog.</p>}
    <div className="catalog-checklist-rows">
      {shown.map(i => {
        const on = selected.includes(i.code);
        const extra = detail?.(i);
        return <div key={i.code} className={`catalog-check-item${on ? " is-on" : ""}`}>
          <div className="catalog-check-row">
            <label className="catalog-check-pick">
              <input type="checkbox" checked={on} onChange={() => toggle(i.code)} />
              <span className="catalog-check-main">
                <b>{i.name}</b>
                <small><code>{i.code}</code>{i.mapped && i.flabsName ? ` → Flabs: ${i.flabsName}` : ""}{extra ? ` · ${extra}` : ""}</small>
              </span>
            </label>
            <span className={`catalog-check-tag ${i.mapped ? "mapped" : "unmapped"}`}>{i.mapped ? "Mapped" : "Not mapped"}</span>
            <span className="catalog-check-price">{i.price ? `₹${i.price}` : "—"}</span>
            <Button variant="outline" size="sm" onClick={() => setEditing(editing === i.code ? null : i.code)}>{editing === i.code ? "Close" : i.mapped ? "Change" : "Map"}</Button>
          </div>
          {editing === i.code && <MapEditor kind={kind} connectionId={connectionId} item={i} flabsList={flabsList}
            onDone={() => { setEditing(null); onMapped(); }} />}
        </div>;
      })}
      {q && shown.length === 0 && <p className="delivery-reason">No {label.toLowerCase()} match "{query}".</p>}
    </div>
  </div>;
}

function MapEditor({ kind, connectionId, item, flabsList, onDone }: {
  kind: "test" | "package"; connectionId: string; item: MapItem; flabsList: FlabsCatalog | null; onDone: () => void;
}) {
  const list = (kind === "test" ? flabsList?.tests : flabsList?.packages) ?? [];
  const canPick = Boolean(flabsList?.available && list.length);
  const [flabsId, setFlabsId] = useState(item.flabsId ?? "");
  const [flabsName, setFlabsName] = useState(item.flabsName ?? "");
  const [filter, setFilter] = useState(canPick ? item.name.split(/\s+/)[0] ?? "" : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const f = filter.trim().toLowerCase();
  const options = canPick ? list.filter(o => !f || o.name.toLowerCase().includes(f) || (o.code ?? "").toLowerCase().includes(f)).slice(0, 50) : [];
  const url = `/api/flabs/connections/${encodeURIComponent(connectionId)}/mappings/${kind}/${encodeURIComponent(item.code)}`;

  const save = async () => {
    setBusy(true); setError("");
    try {
      const res = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flabsId: flabsId.trim(), flabsName: flabsName.trim() || undefined }) });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || "Could not map.");
      onDone();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not map."); } finally { setBusy(false); }
  };
  const unmap = async () => {
    setBusy(true); setError("");
    try {
      const res = await fetch(url, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not remove the mapping.");
      onDone();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not remove the mapping."); } finally { setBusy(false); }
  };

  return <div className="map-editor">
    {canPick ? <div className="form-grid">
      <label className="field"><span>Search Flabs {kind}s</span><input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Name or code" /></label>
      <label className="field"><span>Flabs {kind} *</span>
        <select value={flabsId} onChange={e => setFlabsId(e.target.value)}>
          <option value="">Choose</option>
          {options.map(o => <option key={o._id} value={o._id}>{o.name}{o.code ? ` (${o.code})` : ""}{o.cost ? ` · ₹${o.cost}` : ""}</option>)}
        </select>
      </label>
    </div> : <div className="form-grid">
      <label className="field"><span>Flabs {kind} ID *</span><input value={flabsId} onChange={e => setFlabsId(e.target.value)} placeholder="ID given by Flabs" /></label>
      <label className="field"><span>Name in Flabs</span><input value={flabsName} onChange={e => setFlabsName(e.target.value)} placeholder={item.name} /></label>
    </div>}
    {!canPick && <small className="muted">Flabs does not list {kind}s for this account, so enter the ID Flabs gave you for "{item.name}".</small>}
    {error && <div className="access-message error">{error}</div>}
    <div className="map-editor-actions">
      <Button variant="default" size="sm" disabled={busy || !flabsId.trim()} onClick={() => void save()}><Save size={13} /> {busy ? "Saving…" : "Save mapping"}</Button>
      {item.mapped && <Button variant="destructive" size="sm" disabled={busy} onClick={() => void unmap()}><Trash2 size={13} /> Remove mapping</Button>}
    </div>
  </div>;
}

function NameList({ title, values, setValues }: { title: string; values: string[]; setValues: (v: string[]) => void }) {
  return <div className="rows-block">
    <div className="trace-subhead">{title}</div>
    {values.map((v, i) => <div key={i} className="form-grid" style={{ marginBottom: 8 }}>
      <label className="field full"><span>Name</span><input value={v} onChange={e => setValues(values.map((x, j) => j === i ? e.target.value : x))} /></label>
    </div>)}
    <Button variant="outline" size="sm" onClick={() => setValues([...values, ""])}><Plus size={14} /> Add</Button>
  </div>;
}
