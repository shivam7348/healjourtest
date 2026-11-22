import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Pencil, Plus, RefreshCw, Search, Sparkles, X } from "lucide-react";
import FlabsConnect from "./FlabsConnect";

type CatalogTest = {
  code: string; name: string; loinc?: string; sampleType?: string; unit?: string;
  referenceRange?: string; price: number; active: boolean; updatedAt: string;
  category: string; subcategory: string; categorySource: "auto" | "manual";
  createdFrom?: { connectionId: string; flabsId: string; flabsCode: string };
};
type CatalogPackage = { code: string; name: string; testCodes: string[]; price: number; active: boolean; updatedAt: string };

const emptyTest = { code: "", name: "", loinc: "", sampleType: "", unit: "", referenceRange: "", price: "0", active: true, category: "", subcategory: "" };
const DEFAULT_CATEGORIES = ["Pathology", "Radiology", "Cardiology", "Neurology", "Pulmonology", "Other"];
const NEW_CATEGORY = "__new__";
const PAGE = 150;
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
  const [knownCategories, setKnownCategories] = useState<string[]>(DEFAULT_CATEGORIES);
  const [subcategories, setSubcategories] = useState<Record<string, string[]>>({});
  const [category, setCategory] = useState("all");
  const [subcategory, setSubcategory] = useState("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkCategory, setBulkCategory] = useState("");
  const [bulkSub, setBulkSub] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const load = async () => {
    try {
      const res = await fetch("/api/catalog");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Catalog could not be loaded.");
      setTests(data.tests);
      setPackages(data.packages);
      if (Array.isArray(data.categories)) setKnownCategories(data.categories);
      if (data.subcategories) setSubcategories(data.subcategories);
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

  // Categories in use, known ones first, then any custom ones.
  const categoryList = useMemo(() => {
    const extra = [...new Set(tests.map(t => t.category))].filter(c => c && !knownCategories.includes(c)).sort();
    return [...knownCategories, ...extra];
  }, [tests, knownCategories]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tests) m.set(t.category, (m.get(t.category) ?? 0) + 1);
    return m;
  }, [tests]);
  const subsFor = (cat: string) => [...new Set([...(subcategories[cat] ?? []), ...tests.filter(t => t.category === cat && t.subcategory).map(t => t.subcategory)])];
  const inCategory = useMemo(() => category === "all" ? tests : tests.filter(t => t.category === category), [tests, category]);
  const subCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of inCategory) m.set(t.subcategory || "—", (m.get(t.subcategory || "—") ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [inCategory]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return inCategory
      .filter(t => subcategory === "all" || (t.subcategory || "—") === subcategory)
      .filter(t => !q || t.name.toLowerCase().includes(q) || t.code.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [inCategory, subcategory, query]);
  const pickCategory = (c: string) => { setCategory(c); setSubcategory("all"); setLimit(PAGE); setSelected(new Set()); };

  // Asks for a new category name when "New category…" is chosen; returns "" when cancelled.
  const resolveCategory = (value: string) => {
    if (value !== NEW_CATEGORY) return value;
    const name = (window.prompt("New category name (e.g. Dental, Physiotherapy)") ?? "").trim();
    if (name.length < 2) return "";
    return name.replace(/\s+/g, " ").slice(0, 40);
  };

  const changeCategory = async (codes: string[], body: { category?: string; subcategory?: string; auto?: boolean }) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const res = await fetch("/api/catalog/tests/category", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ codes, ...body }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Category could not be changed.");
      setNotice(data.message);
      setSelected(new Set());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Category could not be changed.");
    } finally {
      setBusy(false);
    }
  };
  const setRowCategory = (t: CatalogTest, value: string) => {
    const cat = resolveCategory(value);
    if (!cat || cat === t.category) return;
    void changeCategory([t.code], { category: cat });
  };
  const setRowSub = (t: CatalogTest, sub: string) => {
    if (sub === t.subcategory) return;
    void changeCategory([t.code], { category: t.category, subcategory: sub || undefined });
  };
  const applyBulk = () => {
    const cat = resolveCategory(bulkCategory);
    if (!cat) return;
    void changeCategory([...selected], { category: cat, subcategory: bulkSub || undefined });
    setBulkCategory(""); setBulkSub("");
  };
  const toggleSelect = (code: string) => setSelected(s => { const n = new Set(s); if (n.has(code)) n.delete(code); else n.add(code); return n; });
  const shown = visible.slice(0, limit);
  const allShownSelected = shown.length > 0 && shown.every(t => selected.has(t.code));
  const toggleAllShown = () => setSelected(s => { const n = new Set(s); for (const t of shown) { if (allShownSelected) n.delete(t.code); else n.add(t.code); } return n; });

  const saveTest = () => save("/api/catalog/tests", {
    ...testForm,
    category: resolveCategory(testForm.category) || undefined,
    subcategory: testForm.subcategory || undefined,
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
      referenceRange: t.referenceRange ?? "", price: String(t.price), active: t.active, category: t.category, subcategory: t.subcategory
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
        <label className="field"><span>Category</span><select value={testForm.category} onChange={e => setTestForm({ ...testForm, category: e.target.value, subcategory: "" })}>
          <option value="">Auto-detect from name</option>
          {categoryList.map(c => <option key={c} value={c}>{c}</option>)}
          <option value={NEW_CATEGORY}>+ New category…</option>
        </select></label>
        <label className="field"><span>Subcategory</span><select value={testForm.subcategory} disabled={!testForm.category || testForm.category === NEW_CATEGORY} onChange={e => setTestForm({ ...testForm, subcategory: e.target.value })}>
          <option value="">—</option>
          {subsFor(testForm.category).map(s => <option key={s} value={s}>{s}</option>)}
        </select></label>
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
      <div className="access-card-head"><div><h2>Tests</h2><p>The full Healjour test catalog, by category. Tests that are new in Flabs are added here on every sync; a sync never changes a test that already exists.</p></div></div>

      <div className="cat-tabs" role="tablist">
        <button type="button" role="tab" className={category === "all" ? "on" : ""} onClick={() => pickCategory("all")}>All <span>{tests.length}</span></button>
        {categoryList.map(c => <button key={c} type="button" role="tab" className={`${category === c ? "on" : ""}${counts.get(c) ? "" : " empty"}`} onClick={() => pickCategory(c)}>
          <i className={`cat-dot cat-${c.toLowerCase().replace(/[^a-z]/g, "")}`} />{c} <span>{counts.get(c) ?? 0}</span>
        </button>)}
      </div>

      {category !== "all" && subCounts.length > 0 && <div className="cat-subs">
        <button type="button" className={subcategory === "all" ? "on" : ""} onClick={() => { setSubcategory("all"); setLimit(PAGE); }}>All {category} <span>{inCategory.length}</span></button>
        {subCounts.map(([s, n]) => <button key={s} type="button" className={subcategory === s ? "on" : ""} onClick={() => { setSubcategory(s); setLimit(PAGE); }}>{s} <span>{n}</span></button>)}
      </div>}

      <div className="cat-toolbar">
        <label className="cat-search"><Search size={14} /><input value={query} onChange={e => { setQuery(e.target.value); setLimit(PAGE); }} placeholder="Search by test name or code" /></label>
        <small>{visible.length} test{visible.length === 1 ? "" : "s"}</small>
      </div>

      {selected.size > 0 && <div className="cat-bulk">
        <b>{selected.size} selected</b>
        <span>Move to</span>
        <select value={bulkCategory} onChange={e => { setBulkCategory(e.target.value); setBulkSub(""); }}>
          <option value="">Category…</option>
          {categoryList.map(c => <option key={c} value={c}>{c}</option>)}
          <option value={NEW_CATEGORY}>+ New category…</option>
        </select>
        <select value={bulkSub} disabled={!bulkCategory || bulkCategory === NEW_CATEGORY} onChange={e => setBulkSub(e.target.value)}>
          <option value="">Subcategory (optional)</option>
          {subsFor(bulkCategory).map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <Button size="sm" variant="default" disabled={busy || !bulkCategory} onClick={applyBulk}>Apply</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void changeCategory([...selected], { auto: true })}><Sparkles size={13} /> Auto-detect</Button>
        <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
      </div>}

      <div className="access-table-wrap"><table className="access-table cat-table">
        <thead><tr>
          <th className="cat-check"><input type="checkbox" aria-label="Select all shown" checked={allShownSelected} onChange={toggleAllShown} /></th>
          <th>CODE</th><th>NAAM</th><th>CATEGORY</th><th>PRICE</th><th>STATUS</th><th></th>
        </tr></thead>
        <tbody>{shown.map(t => <tr key={t.code} className={selected.has(t.code) ? "picked" : ""}>
          <td className="cat-check"><input type="checkbox" aria-label={`Select ${t.code}`} checked={selected.has(t.code)} onChange={() => toggleSelect(t.code)} /></td>
          <td><code>{t.code}</code></td>
          <td>{t.name}{t.createdFrom && <span className="cat-src" title={`Created from Flabs test ${t.createdFrom.flabsCode.trim()}`}>from Flabs</span>}</td>
          <td><div className="cat-cell">
            <select aria-label={`Category of ${t.code}`} value={t.category} disabled={busy} onChange={e => setRowCategory(t, e.target.value)}>
              {categoryList.map(c => <option key={c} value={c}>{c}</option>)}
              <option value={NEW_CATEGORY}>+ New category…</option>
            </select>
            <select aria-label={`Subcategory of ${t.code}`} value={t.subcategory} disabled={busy} onChange={e => setRowSub(t, e.target.value)}>
              <option value="">—</option>
              {[...new Set([...subsFor(t.category), ...(t.subcategory ? [t.subcategory] : [])])].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            {t.categorySource === "auto"
              ? <span className="cat-auto" title="Detected from the test name. Change it to fix it for good.">auto</span>
              : <span className="cat-manual" title="Set by hand. Syncs never change it.">set</span>}
          </div></td>
          <td>₹{t.price}</td>
          <td><span className={`access-status ${t.active ? "active" : "revoked"}`}>{t.active ? "active" : "inactive"}</span></td>
          <td><Button variant="outline" size="sm" onClick={() => editTest(t)}><Pencil size={13} /> Edit</Button></td>
        </tr>)}
        {shown.length === 0 && <tr><td colSpan={7} className="cat-none">No tests here{query ? ` matching “${query}”` : ""}.</td></tr>}
        </tbody>
      </table></div>
      {visible.length > shown.length && <div className="cat-more"><Button variant="outline" size="sm" onClick={() => setLimit(l => l + PAGE)}>Show {Math.min(PAGE, visible.length - shown.length)} more of {visible.length - shown.length}</Button></div>}
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
