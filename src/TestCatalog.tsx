import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { CheckCircle2, Pencil, Plus, RefreshCw, X } from "lucide-react";
import FlabsConnect from "./FlabsConnect";

type CatalogTest = {
  code: string; name: string; loinc?: string; sampleType?: string; unit?: string;
  referenceRange?: string; price: number; active: boolean; updatedAt: string;
};
type CatalogPackage = { code: string; name: string; testCodes: string[]; price: number; active: boolean; updatedAt: string };

const emptyTest = { code: "", name: "", loinc: "", sampleType: "", unit: "", referenceRange: "", price: "0", active: true };
const emptyPackage = { code: "", name: "", price: "0", testCodes: [] as string[], active: true };

export default function TestCatalog() {
  const [tab, setTab] = useState<"tests" | "packages">("tests");
  const [tests, setTests] = useState<CatalogTest[]>([]);
  const [packages, setPackages] = useState<CatalogPackage[]>([]);
  const [testForm, setTestForm] = useState(emptyTest);
  const [packageForm, setPackageForm] = useState(emptyPackage);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = async () => {
    try {
      const res = await fetch("/api/catalog");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Catalog could not be loaded.");
      setTests(data.tests);
      setPackages(data.packages);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Backend not reachable.");
    }
  };
  useEffect(() => { void load(); }, []);

  const save = async (path: string, body: unknown) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed.");
      setNotice(data.message);
      setEditing(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  };

  const saveTest = () => save("/api/catalog/tests", {
    ...testForm,
    loinc: testForm.loinc || undefined,
    sampleType: testForm.sampleType || undefined,
    unit: testForm.unit || undefined,
    referenceRange: testForm.referenceRange || undefined,
    price: Number(testForm.price)
  });

  const savePackage = () => save("/api/catalog/packages", { ...packageForm, price: Number(packageForm.price) });

  const editTest = (t: CatalogTest) => {
    setTestForm({
      code: t.code, name: t.name, loinc: t.loinc ?? "", sampleType: t.sampleType ?? "", unit: t.unit ?? "",
      referenceRange: t.referenceRange ?? "", price: String(t.price), active: t.active
    });
    setEditing(true); setTab("tests");
  };

  const editPackage = (p: CatalogPackage) => {
    setPackageForm({ code: p.code, name: p.name, price: String(p.price), testCodes: p.testCodes, active: p.active });
    setEditing(true); setTab("packages");
  };

  const toggleTestInPackage = (code: string) =>
    setPackageForm(f => ({ ...f, testCodes: f.testCodes.includes(code) ? f.testCodes.filter(c => c !== code) : [...f.testCodes, code] }));

  const startNew = () => {
    setEditing(true);
    setTestForm(emptyTest);
    setPackageForm(emptyPackage);
    // The form sits below the Flabs card, so bring it into view.
    setTimeout(() => document.getElementById("catalog-form")?.scrollIntoView({ block: "start" }), 60);
  };

  return <div className="content">
    <div className="page-heading">
      <div>
        <div className="eyebrow">HEALJOUR CATALOG</div>
        <h1>Tests & packages</h1>
        <p>Healjour's own tests and packages. Other systems (like Flabs) will map these to their own IDs.</p>
      </div>
      <div className="heading-actions">
        <Button variant="outline" onClick={() => void load()} disabled={busy}><RefreshCw size={15} /> Refresh</Button>
        <Button variant="default" onClick={startNew} disabled={busy}><Plus size={15} /> New {tab === "tests" ? "test" : "package"}</Button>
      </div>
    </div>

    <div className="segmented" style={{ marginBottom: 16 }}>
      <Button variant="ghost" className={cn("h-auto", tab === "tests" ? "selected" : "")} onClick={() => setTab("tests")}>Tests ({tests.length})</Button>
      <Button variant="ghost" className={cn("h-auto", tab === "packages" ? "selected" : "")} onClick={() => setTab("packages")}>Packages ({packages.length})</Button>
    </div>

    <FlabsConnect onChanged={() => void load()} />

    {editing && tab === "tests" && <section className="access-card" id="catalog-form">
      <div className="access-card-head"><div><h2>{testForm.code && tests.some(t => t.code === testForm.code) ? `Edit ${testForm.code}` : "New test"}</h2><p>Code must be unique. This is Healjour's internal code.</p></div></div>
      <div className="form-grid">
        <label className="field"><span>Code *</span><input value={testForm.code} onChange={e => setTestForm({ ...testForm, code: e.target.value.toUpperCase() })} placeholder="CBC" /></label>
        <label className="field"><span>Name *</span><input value={testForm.name} onChange={e => setTestForm({ ...testForm, name: e.target.value })} placeholder="Complete Blood Count" /></label>
        <label className="field"><span>LOINC</span><input value={testForm.loinc} onChange={e => setTestForm({ ...testForm, loinc: e.target.value })} placeholder="58410-2" /></label>
        <label className="field"><span>Price (₹) *</span><input type="number" min="0" value={testForm.price} onChange={e => setTestForm({ ...testForm, price: e.target.value })} /></label>
        <label className="field"><span>Sample type</span><input value={testForm.sampleType} onChange={e => setTestForm({ ...testForm, sampleType: e.target.value })} placeholder="Blood" /></label>
        <label className="field"><span>Unit</span><input value={testForm.unit} onChange={e => setTestForm({ ...testForm, unit: e.target.value })} placeholder="mg/dL" /></label>
        <label className="field"><span>Reference range</span><input value={testForm.referenceRange} onChange={e => setTestForm({ ...testForm, referenceRange: e.target.value })} placeholder="70-100" /></label>
        <label className="field"><span>Status</span><select value={testForm.active ? "active" : "inactive"} onChange={e => setTestForm({ ...testForm, active: e.target.value === "active" })}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
      </div>
      <div className="credential-actions">
        <Button variant="default" disabled={busy || !testForm.code || !testForm.name} onClick={() => void saveTest()}><CheckCircle2 size={15} /> Save test</Button>
        <Button variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
      </div>
    </section>}

    {editing && tab === "packages" && <section className="access-card" id="catalog-form">
      <div className="access-card-head"><div><h2>{packageForm.code && packages.some(p => p.code === packageForm.code) ? `Edit ${packageForm.code}` : "New package"}</h2><p>Choose which tests are in this package.</p></div></div>
      <div className="form-grid">
        <label className="field"><span>Code *</span><input value={packageForm.code} onChange={e => setPackageForm({ ...packageForm, code: e.target.value.toUpperCase() })} placeholder="BASIC-CHECK" /></label>
        <label className="field"><span>Name *</span><input value={packageForm.name} onChange={e => setPackageForm({ ...packageForm, name: e.target.value })} placeholder="Basic health checkup" /></label>
        <label className="field"><span>Package price (₹) *</span><input type="number" min="0" value={packageForm.price} onChange={e => setPackageForm({ ...packageForm, price: e.target.value })} /></label>
        <label className="field"><span>Status</span><select value={packageForm.active ? "active" : "inactive"} onChange={e => setPackageForm({ ...packageForm, active: e.target.value === "active" })}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
      </div>
      <div className="scope-heading"><div><h3>Tests in this package</h3><p>{packageForm.testCodes.length} selected</p></div></div>
      <div className="scope-list">
        {tests.map(t => <label key={t.code} className="scope-option">
          <input type="checkbox" checked={packageForm.testCodes.includes(t.code)} onChange={() => toggleTestInPackage(t.code)} />
          <span><b>{t.name}</b><small>₹{t.price}</small><code>{t.code}</code></span>
        </label>)}
      </div>
      <div className="credential-actions">
        <Button variant="default" disabled={busy || !packageForm.code || !packageForm.name || packageForm.testCodes.length === 0} onClick={() => void savePackage()}><CheckCircle2 size={15} /> Save package</Button>
        <Button variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
      </div>
    </section>}

    {tab === "tests" && <section className="access-card">
      <div className="access-card-head"><div><h2>Tests</h2><p>The full Healjour test catalog.</p></div></div>
      <div className="access-table-wrap"><table className="access-table">
        <thead><tr><th>CODE</th><th>NAAM</th><th>LOINC</th><th>PRICE</th><th>STATUS</th><th></th></tr></thead>
        <tbody>{tests.map(t => <tr key={t.code}>
          <td><code>{t.code}</code></td><td>{t.name}</td><td>{t.loinc ?? "—"}</td><td>₹{t.price}</td>
          <td><span className={`access-status ${t.active ? "active" : "revoked"}`}>{t.active ? "active" : "inactive"}</span></td>
          <td><Button variant="outline" size="sm" onClick={() => editTest(t)}><Pencil size={13} /> Edit</Button></td>
        </tr>)}</tbody>
      </table></div>
    </section>}

    {tab === "packages" && <section className="access-card">
      <div className="access-card-head"><div><h2>Packages</h2><p>Packages are built only from catalog tests.</p></div></div>
      <div className="access-table-wrap"><table className="access-table">
        <thead><tr><th>CODE</th><th>NAAM</th><th>TESTS</th><th>PRICE</th><th>STATUS</th><th></th></tr></thead>
        <tbody>{packages.map(p => <tr key={p.code}>
          <td><code>{p.code}</code></td><td>{p.name}</td><td>{p.testCodes.join(", ")}</td><td>₹{p.price}</td>
          <td><span className={`access-status ${p.active ? "active" : "revoked"}`}>{p.active ? "active" : "inactive"}</span></td>
          <td><Button variant="outline" size="sm" onClick={() => editPackage(p)}><Pencil size={13} /> Edit</Button></td>
        </tr>)}</tbody>
      </table></div>
    </section>}

    {error && <div className="access-message error"><X size={16} />{error}<Button className="h-auto" variant="ghost" onClick={() => setError("")}>Dismiss</Button></div>}
    {notice && <div className="access-message success"><CheckCircle2 size={16} />{notice}<Button className="h-auto" variant="ghost" onClick={() => setNotice("")}>Dismiss</Button></div>}
    <div className="access-bottom-note">Prices are placeholders (₹0) for now. Set the real rates here.</div>
  </div>;
}
