import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { CheckCircle2, Send, X } from "lucide-react";
import DateTimeField from "./DateTimeField";
import { MapEditor, type FlabsCatalog, type MapItem } from "./PreBookingForm";

type Connection = { id: string; label: string; branchId: string | null; phase: "lead" | "booking"; party: { field: string; id: string } | null; isDefault: boolean };
type Option = { code: string; name: string; price: number; mapped: boolean; flabsCost?: number | null };
type PackageOption = { code: string; name: string; price: number; testCodes: string[]; mapped: boolean };
type Options = { connection: Connection; tests: Option[]; packages: PackageOption[] };
type Row = { name: string; amount: string };
type Result = {
  ok: boolean; message?: string; error?: string; integratorID?: string; leadId?: string; phase?: string;
  mappedTests?: string[]; unmappedTests?: string[]; mappedPackages?: string[]; unmappedPackages?: string[];
};

const PARTY_FIELDS = [
  { value: "", label: "None" },
  { value: "corporateUser", label: "Corporate (corporateUser)" },
  { value: "referredOrganization", label: "Referring doctor (referredOrganization)" },
  { value: "referredHospitalOrganization", label: "Referring hospital (referredHospitalOrganization)" }
];

/** Manual lead/booking entry for Flabs CRM. Every field here maps to the Flabs Create Lead API. */
export default function FlabsBookingForm() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [options, setOptions] = useState<Options | null>(null);
  const [f, setF] = useState({
    first_name: "", last_name: "", designation: "", contact: "", country_code: "91", email: "",
    age: "", age_type: "year", gender: "", weight: "", height: "", address: "", pincode: "", googleLocation: "",
    aadhaar_number: "", insurance_number: "", uhid: "", passport_number: "",
    owner_name: "", breed: "", category: "",
    integratorID: "", phase: "", source: "healjour", priority: "medium",
    partyField: "", partyId: "",
    discountAmount: "0", totalAmount: "",
    bookingType: "", scheduledAt: "", specialInstructions: "", paymentStatus: "Pending", paymentMode: "",
    customFields: ""
  });
  const set = (key: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [key]: e.target.value });

  const [testCodes, setTestCodes] = useState<string[]>([]);
  const [packageCodes, setPackageCodes] = useState<string[]>([]);
  const [unmappedTests, setUnmappedTests] = useState<Row[]>([]);
  const [unmappedPackages, setUnmappedPackages] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/flabs/connections");
      if (!res.ok) return;
      const data = await res.json();
      setConnections(data.connections);
      const def = data.connections.find((c: Connection) => c.isDefault) ?? data.connections[0];
      if (def) setConnectionId(def.id);
    })();
  }, []);

  const [optionsVersion, setOptionsVersion] = useState(0); // bumped after a mapping is saved

  useEffect(() => {
    if (!connectionId) return;
    void (async () => {
      const res = await fetch(`/api/flabs/booking-options?connectionId=${encodeURIComponent(connectionId)}`);
      if (res.ok) setOptions(await res.json());
    })();
  }, [connectionId, optionsVersion]);

  useEffect(() => { setTestCodes([]); setPackageCodes([]); }, [connectionId]);

  const toggle = (list: string[], code: string, set: (v: string[]) => void) =>
    set(list.includes(code) ? list.filter(c => c !== code) : [...list, code]);

  const connection = options?.connection;
  const partyLocked = Boolean(connection?.party);
  const selectedTotal =
    (options?.tests.filter(t => testCodes.includes(t.code)).reduce((s, t) => s + (t.flabsCost ?? t.price), 0) ?? 0) +
    (options?.packages.filter(p => packageCodes.includes(p.code)).reduce((s, p) => s + p.price, 0) ?? 0) +
    unmappedTests.reduce((s, r) => s + (Number(r.amount) || 0), 0) +
    unmappedPackages.reduce((s, r) => s + (Number(r.amount) || 0), 0);

  const submit = async () => {
    setBusy(true); setError(""); setResult(null);
    try {
      let customFields: Record<string, string | number | boolean> | undefined;
      if (f.customFields.trim()) {
        customFields = JSON.parse(f.customFields);
      }
      const body = {
        connectionId,
        integratorID: f.integratorID || undefined,
        first_name: f.first_name,
        last_name: f.last_name || undefined,
        designation: f.designation || undefined,
        contact: f.contact,
        country_code: f.country_code || "91",
        email: f.email || undefined,
        age: Number(f.age),
        age_type: f.age_type,
        gender: f.gender || undefined,
        weight: f.weight ? Number(f.weight) : undefined,
        height: f.height ? Number(f.height) : undefined,
        address: f.address || undefined,
        pincode: f.pincode || undefined,
        googleLocation: f.googleLocation || undefined,
        aadhaar_number: f.aadhaar_number || undefined,
        insurance_number: f.insurance_number || undefined,
        uhid: f.uhid || undefined,
        passport_number: f.passport_number || undefined,
        owner_name: f.owner_name || undefined,
        breed: f.breed || undefined,
        category: f.category || undefined,
        phase: f.phase || undefined,
        source: f.source || undefined,
        priority: f.priority || undefined,
        ...(!partyLocked && f.partyField && f.partyId ? { [f.partyField]: f.partyId } : {}),
        tests: testCodes.map(code => ({ code })),
        packages: packageCodes.map(code => ({ code })),
        unmappedTests: unmappedTests.filter(r => r.name).map(r => ({ name: r.name, cost: Number(r.amount) || 0 })),
        unmappedPackages: unmappedPackages.filter(r => r.name).map(r => ({ name: r.name, price: Number(r.amount) || 0 })),
        discountAmount: Number(f.discountAmount) || 0,
        totalAmount: f.totalAmount ? Number(f.totalAmount) : undefined,
        bookingType: f.bookingType || undefined,
        scheduledAt: f.scheduledAt ? new Date(f.scheduledAt).toISOString() : undefined,
        specialInstructions: f.specialInstructions || undefined,
        paymentStatus: f.paymentStatus || undefined,
        paymentMode: f.paymentMode || undefined,
        customFields
      };
      const res = await fetch("/api/flabs/bookings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data: Result = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Booking was not sent.");
      setResult(data);
    } catch (e) {
      setError(e instanceof SyntaxError ? "Custom fields must be valid JSON." : e instanceof Error ? e.message : "Booking was not sent.");
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = Boolean(connectionId && f.first_name && /^\d{10}$/.test(f.contact) && f.age && (testCodes.length + packageCodes.length + unmappedTests.length + unmappedPackages.length) > 0);

  if (connections.length === 0) {
    return <div className="content">
      <div className="empty-state"><b>First connect a Flabs account</b><p>Go to Test Catalog → Flabs CRM accounts and add an account. Then you can send bookings from here.</p></div>
    </div>;
  }

  return <div className="content core-page flabs-theme">
    <div className="page-heading">
      <div>
        <div className="eyebrow">ORDERS & BOOKINGS</div>
        <h1>New lead / booking in Flabs</h1>
        <p>Create a clean patient record, select services, and send it to Flabs CRM in a few steps.</p>
      </div>
    </div>

    <div className="booking-layout">
      <div className="booking-main">
        <section className="access-card">
          <div className="access-card-head"><div><h2>1. Account</h2><p>Choose the Flabs account for this lead or booking.</p></div></div>
          <div className="form-grid">
            <label className="field"><span>Flabs account *</span>
              <select value={connectionId} onChange={e => setConnectionId(e.target.value)}>
                {connections.map(c => <option key={c.id} value={c.id}>{c.label}{c.isDefault ? " (default)" : ""}</option>)}
              </select>
            </label>
            {connection && <div className="booking-meta">
              <div><small>Branch</small><code>{connection.branchId}</code></div>
              <div><small>Phase</small><span className="booking-pill">{connection.phase === "booking" ? "Booking" : "Lead"}</span></div>
              <div><small>Party</small>{connection.party ? <code>{connection.party.field}: {connection.party.id}</code> : <span className="muted">None (general lab)</span>}</div>
            </div>}
          </div>
        </section>

        <section className="access-card">
          <div className="access-card-head"><div><h2>2. Patient details</h2><p>Fields marked * are required.</p></div></div>
          <div className="form-grid">
            <label className="field"><span>First name *</span><input value={f.first_name} onChange={set("first_name")} /></label>
            <label className="field"><span>Last name</span><input value={f.last_name} onChange={set("last_name")} /></label>
            <label className="field"><span>Designation</span><input value={f.designation} onChange={set("designation")} placeholder="Mr / Mrs / Dr" /></label>
            <label className="field"><span>Mobile number *</span>
              <div className="phone-input">
                <span className="phone-prefix">+{f.country_code || "91"}</span>
                <input value={f.contact} onChange={e => setF({ ...f, contact: e.target.value.replace(/\D/g, "").slice(0, 10) })} placeholder="10-digit mobile" inputMode="numeric" maxLength={10} />
              </div>
              <small>Country code +{f.country_code || "91"}; enter only the 10-digit mobile number.</small>
            </label>
            <label className="field"><span>Email</span><input type="email" value={f.email} onChange={set("email")} /></label>
            <label className="field"><span>Age *</span><input type="number" min="0" value={f.age} onChange={set("age")} /></label>
            <label className="field"><span>Age type *</span>
              <select value={f.age_type} onChange={set("age_type")}><option value="year">Year</option><option value="month">Month</option><option value="day">Day</option></select>
            </label>
            <label className="field"><span>Gender</span>
              <select value={f.gender} onChange={set("gender")}><option value="">—</option><option value="male">Male</option><option value="female">Female</option><option value="other">Other</option></select>
            </label>
            <label className="field"><span>Weight (kg)</span><input type="number" min="0" value={f.weight} onChange={set("weight")} /></label>
            <label className="field"><span>Height (cm)</span><input type="number" min="0" value={f.height} onChange={set("height")} /></label>
            <label className="field full"><span>Address</span><input value={f.address} onChange={set("address")} /></label>
            <label className="field"><span>Pincode</span><input value={f.pincode} onChange={set("pincode")} /></label>
            <label className="field"><span>Google location</span><input value={f.googleLocation} onChange={set("googleLocation")} placeholder="12.97,77.59 or Maps link" /></label>
            <label className="field"><span>Aadhaar number</span><input value={f.aadhaar_number} onChange={set("aadhaar_number")} /></label>
            <label className="field"><span>Insurance number</span><input value={f.insurance_number} onChange={set("insurance_number")} /></label>
            <label className="field"><span>UHID</span><input value={f.uhid} onChange={set("uhid")} /></label>
            <label className="field"><span>Passport number</span><input value={f.passport_number} onChange={set("passport_number")} /></label>
          </div>
          <div className="trace-subhead">Veterinary (for pets only)</div>
          <div className="form-grid">
            <label className="field"><span>Owner name</span><input value={f.owner_name} onChange={set("owner_name")} /></label>
            <label className="field"><span>Breed</span><input value={f.breed} onChange={set("breed")} /></label>
            <label className="field"><span>Category</span><input value={f.category} onChange={set("category")} /></label>
          </div>
        </section>

        <section className="access-card">
          <div className="access-card-head"><div><h2>3. Lead and workflow</h2><p>Set the lead phase, source, and party mapping.</p></div></div>
          <div className="form-grid">
            <label className="field"><span>Integrator ID</span><input value={f.integratorID} onChange={set("integratorID")} placeholder="Optional custom ID" /><small>Used for downstream tracking and webhooks.</small></label>
            <label className="field"><span>Phase</span>
              <select value={f.phase} onChange={set("phase")}><option value="">Account default ({connection?.phase ?? "booking"})</option><option value="lead">Lead (in funnel)</option><option value="booking">Booking (confirmed)</option></select>
            </label>
            <label className="field"><span>Priority</span>
              <select value={f.priority} onChange={set("priority")}><option value="urgent">Urgent</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select>
            </label>
            <label className="field"><span>Source</span><input value={f.source} onChange={set("source")} placeholder="facebook_ads / website / healjour" /></label>
            {!partyLocked && <>
              <label className="field"><span>Party (corporate / referral)</span>
                <select value={f.partyField} onChange={set("partyField")}>{PARTY_FIELDS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
              </label>
              {f.partyField && <label className="field"><span>Party ID *</span><input value={f.partyId} onChange={set("partyId")} /></label>}
            </>}
            {partyLocked && <div className="field full"><small>This account already has a party set, so that one will be used automatically.</small></div>}
          </div>
        </section>

        <section className="access-card">
          <div className="access-card-head"><div><h2>4. Tests and packages</h2><p>Select from the Healjour catalog or add unmapped items.</p></div></div>
          <CatalogPicker
            label="Tests"
            placeholder="Search a test by name or code"
            items={options?.tests ?? []}
            selected={testCodes}
            onChange={setTestCodes}
            connectionId={connectionId} kind="test" creatable onMapped={() => setOptionsVersion(v => v + 1)}
            describe={t => `₹${t.flabsCost ?? t.price} · ${t.mapped ? "mapped" : "unmapped"}`}
          />
          <CatalogPicker
            label="Packages"
            placeholder="Search a package by name or code"
            items={options?.packages ?? []}
            selected={packageCodes}
            onChange={setPackageCodes}
            connectionId={connectionId} kind="package" onMapped={() => setOptionsVersion(v => v + 1)}
            describe={p => `₹${p.price} · ${p.mapped ? "mapped" : "unmapped"}`}
          />
          <RowList title="Unmapped tests (name + amount)" rows={unmappedTests} setRows={setUnmappedTests} />
          <RowList title="Unmapped packages (name + amount)" rows={unmappedPackages} setRows={setUnmappedPackages} />
        </section>

        <section className="access-card">
          <div className="access-card-head"><div><h2>5. Payment and booking</h2><p>Leave the total empty to auto-calculate from the selected services.</p></div></div>
          <div className="form-grid">
            <label className="field"><span>Discount (₹)</span><input type="number" min="0" value={f.discountAmount} onChange={set("discountAmount")} /></label>
            <label className="field"><span>Total (₹) — auto: ₹{selectedTotal}</span><input type="number" min="0" value={f.totalAmount} onChange={set("totalAmount")} /></label>
            <label className="field"><span>Payment status</span>
              <select value={f.paymentStatus} onChange={set("paymentStatus")}><option>Pending</option><option>Paid</option><option>Pay Later</option></select>
            </label>
            <label className="field"><span>Payment mode</span>
              <select value={f.paymentMode} onChange={set("paymentMode")}><option value="">—</option><option>Razorpay UPI</option><option>Card</option><option>Cash</option></select>
            </label>
            <label className="field"><span>Booking type</span>
              <select value={f.bookingType} onChange={set("bookingType")}><option value="">—</option><option>Home Collection</option><option>Lab Visit</option></select>
            </label>
            <label className="field"><span>Scheduled at</span><DateTimeField value={f.scheduledAt} onChange={v => setF({ ...f, scheduledAt: v })} /></label>
            <label className="field full"><span>Special instructions</span><textarea value={f.specialInstructions} onChange={set("specialInstructions")} rows={2} /></label>
            <label className="field full"><span>Custom fields (JSON, optional)</span><textarea value={f.customFields} onChange={set("customFields")} rows={2} placeholder='{"utm_campaign": "summer_sale"}' /></label>
          </div>
        </section>
      </div>

      <aside className="booking-sidebar">
        <div className="access-card">
          <div className="access-card-head"><div><h2>Summary</h2><p>Quick check before sending.</p></div></div>
          <div className="booking-summary-list">
            <div><span>Patient</span><strong>{f.first_name || "Not added"}{f.last_name ? ` ${f.last_name}` : ""}</strong></div>
            <div><span>Contact</span><strong>{f.contact ? `+${f.country_code || "91"} ${f.contact}` : "Not added"}</strong></div>
            <div><span>Services</span><strong>{testCodes.length + packageCodes.length + unmappedTests.length + unmappedPackages.length || 0} selected</strong></div>
            <div><span>Phase</span><strong>{f.phase || connection?.phase || "booking"}</strong></div>
          </div>
          <div className="booking-summary-total">
            <small>Estimated total</small>
            <b>₹{selectedTotal}</b>
          </div>
          {!canSubmit && <div className="booking-hint-box">Needs: connection, first name, valid 10-digit mobile, age, and at least one test or package.</div>}
        </div>
      </aside>
    </div>

    {error && <div className="access-message error"><X size={16} />{error}<Button className="h-auto" variant="ghost" onClick={() => setError("")}>Dismiss</Button></div>}
    {result?.ok && <div className="access-message success"><CheckCircle2 size={16} />{result.message}{result.leadId ? ` Lead ID: ${result.leadId}` : ""} · Integrator ID: {result.integratorID}
      {(result.unmappedTests?.length || result.unmappedPackages?.length) ? <> · Unmapped bheje: {[...(result.unmappedTests ?? []), ...(result.unmappedPackages ?? [])].join(", ")}</> : null}
    </div>}

    <div className="booking-actionbar">
      <div>
        <small>Estimated total</small>
        <b>₹{selectedTotal}</b>
      </div>
      <Button variant="default" disabled={busy || !canSubmit} onClick={() => void submit()}><Send size={15} /> {busy ? "Sending…" : "Send to Flabs"}</Button>
    </div>
  </div>;
}

/** Case-insensitive match on name or code. Empty query shows everything. */
function filterByQuery<T extends { name: string; code: string }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  const exact = items.some(i => i.code.toLowerCase() === q || i.name.toLowerCase() === q);
  if (!q) return items;
  return items.filter(i => i.name.toLowerCase().includes(q) || i.code.toLowerCase().includes(q));
}

function RowList({ title, rows, setRows }: { title: string; rows: Row[]; setRows: (r: Row[]) => void }) {
  return <div className="rows-block">
    <div className="trace-subhead">{title}</div>
    {rows.map((r, i) => <div key={i} className="form-grid" style={{ marginBottom: 8 }}>
      <label className="field"><span>Name</span><input value={r.name} onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} /></label>
      <label className="field"><span>Amount (₹)</span><input type="number" min="0" value={r.amount} onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} /></label>
    </div>)}
    <Button variant="outline" size="sm" onClick={() => setRows([...rows, { name: "", amount: "0" }])}>+ Add row</Button>
  </div>;
}

export type PickerItem = { code: string; name: string; price: number; mapped: boolean; flabsCost?: number | null };

/**
 * Search-only picker: nothing is listed until you type. Matches appear below the box;
 * clicking one adds it, and each added item shows as a chip that can be removed.
 */
export function CatalogPicker({ label, placeholder, items, selected, onChange, describe, connectionId, kind, onMapped, creatable }: {
  label: string; placeholder: string; items: PickerItem[]; selected: string[];
  onChange: (codes: string[]) => void; describe: (item: PickerItem) => string;
  connectionId?: string; kind?: "test" | "package"; onMapped?: () => void;
  /** Tests only: offer "create new test" when the search finds nothing. */
  creatable?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [mapFor, setMapFor] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ code: "", name: "", price: "" });
  const [createError, setCreateError] = useState("");
  const [createBusy, setCreateBusy] = useState(false);

  const openCreate = () => {
    setDraft({ code: query.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 30), name: query.trim(), price: "" });
    setCreateError(""); setCreating(true);
  };
  const saveNewTest = async () => {
    setCreateBusy(true); setCreateError("");
    try {
      const body = { code: draft.code, name: draft.name.trim(), price: Number(draft.price || 0), active: true };
      const res = await fetch("/api/catalog/tests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not create the test.");
      // The new test is chosen straight away; it is not mapped yet, so it goes to Flabs by name until mapped.
      onChange([...selected, draft.code]);
      setCreating(false); setQuery("");
      onMapped?.();
    } catch (e) { setCreateError(e instanceof Error ? e.message : "Could not create the test."); }
    finally { setCreateBusy(false); }
  };
  const codeOk = /^[A-Z0-9-]{2,30}$/.test(draft.code) && !items.some(i => i.code === draft.code);
  const formOk = codeOk && draft.name.trim().length >= 2 && Number(draft.price || 0) >= 0;
  const [flabsList, setFlabsList] = useState<FlabsCatalog | null>(null);
  useEffect(() => {
    setFlabsList(null);
    if (!connectionId) return;
    void fetch(`/api/flabs/connections/${encodeURIComponent(connectionId)}/flabs-catalog`).then(r => r.json()).then(setFlabsList).catch(() => undefined);
  }, [connectionId]);
  const q = query.trim().toLowerCase();
  const matches = q
    ? items.filter(i => !selected.includes(i.code) && (i.name.toLowerCase().includes(q) || i.code.toLowerCase().includes(q))).slice(0, 8)
    : [];
  const chosen = items.filter(i => selected.includes(i.code));

  return <div className="catalog-picker">
    <div className="trace-subhead">{label}</div>
    <input className="list-search" placeholder={placeholder} value={query} onChange={e => setQuery(e.target.value)} />
    {matches.length > 0 && <div className="catalog-picker-results">
      {matches.map(i => <div key={i.code} className="catalog-picker-row">
        <Button variant="ghost" className="h-auto catalog-picker-item" onClick={() => { onChange([...selected, i.code]); setQuery(""); }}>
          <span><b>{i.name}</b><small>{i.code}</small></span>
          <em>{describe(i)}</em>
        </Button>
        {connectionId && kind && <Button variant="outline" size="sm" onClick={() => setMapFor(mapFor === i.code ? null : i.code)}>
          {mapFor === i.code ? "Close" : i.mapped ? "Change" : "Map"}
        </Button>}
        {connectionId && kind && mapFor === i.code && <MapEditor kind={kind} connectionId={connectionId} item={i as MapItem} flabsList={flabsList}
          onDone={() => { setMapFor(null); onMapped?.(); }} />}
      </div>)}
    </div>}
    {q && matches.length === 0 && !creating && <p className="delivery-reason">No {label.toLowerCase()} match "{query}".</p>}
    {creatable && q && !exact && !creating && <button type="button" className="create-new-row" onClick={openCreate}>
      <b>+ Create new test</b> <span>"{query.trim()}" is added to the Healjour catalog and chosen</span>
    </button>}
    {creatable && creating && <div className="create-new-form">
      <div className="trace-subhead">New test</div>
      <div className="form-grid">
        <label className="field"><span>Code *</span><input value={draft.code} onChange={e => setDraft({ ...draft, code: e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "") })} placeholder="e.g. CBC" />
          {draft.code && !codeOk && <small className="builder-problem">{items.some(i => i.code === draft.code) ? "This code already exists." : "2-30 capital letters, digits or -"}</small>}</label>
        <label className="field"><span>Name *</span><input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
        <label className="field"><span>Price ₹</span><input inputMode="decimal" value={draft.price} onChange={e => setDraft({ ...draft, price: e.target.value })} placeholder="0" /></label>
      </div>
      {createError && <div className="access-message error">{createError}</div>}
      <div className="builder-actions">
        <Button variant="default" size="sm" disabled={createBusy || !formOk} onClick={() => void saveNewTest()}>{createBusy ? "Saving…" : "Save and choose"}</Button>
        <Button variant="outline" size="sm" onClick={() => setCreating(false)}>Cancel</Button>
      </div>
    </div>}
    {chosen.length > 0 && <div className="catalog-chips">
      {chosen.map(i => <span key={i.code} className="catalog-chip">
        {i.name} <small>({i.code})</small>
        <Button className="h-auto" variant="ghost" aria-label={`Remove ${i.name}`} onClick={() => onChange(selected.filter(c => c !== i.code))}>×</Button>
      </span>)}
    </div>}
  </div>;
}
