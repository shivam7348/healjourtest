import { useEffect, useState } from "react";
import { CheckCircle2, Link2, Plus, Save, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";

type Row = { code: string; name: string; sampleType: string; unit: string; price: string; loinc: string };
type Connection = { id: string; label: string; party: unknown; isDefault: boolean };
type Suggestion = {
  healjourCode: string; healjourName: string;
  flabsId: string | null; flabsName: string | null; flabsCode: string | null; flabsCost: number | null;
  confidence: "high" | "medium" | "low" | "none"; reason: string;
};
type SaveResult = { created: string[]; updated: string[]; errors: Array<{ row: number; code?: string; error: string }>; packageMessage?: string };

const EXAMPLE = `CBC 350
Lipid profile 800
HbA1c 450
Thyroid profile (T3, T4, TSH) 600
Vitamin D 1200`;

const blankRow = (): Row => ({ code: "", name: "", sampleType: "", unit: "", price: "", loinc: "" });
const CODE_RE = /^[A-Z0-9-]{2,30}$/;

/**
 * Test Builder: onboard a lab's tests in three steps.
 * 1. Write or paste them (Claude, when configured, turns the text into rows). 2. Review and save to the catalog.
 * 3. Match them to the lab's Flabs tests and save the mappings staff accept.
 */
export default function TestBuilder() {
  const [ai, setAi] = useState<{ ai: boolean; model: string | null } | null>(null);
  const [text, setText] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [draftNote, setDraftNote] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [makePackage, setMakePackage] = useState(false);
  const [pkg, setPkg] = useState({ code: "", name: "", price: "" });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SaveResult | null>(null);
  const [error, setError] = useState("");

  const [catalogCodes, setCatalogCodes] = useState<Set<string>>(new Set());
  const loadCatalog = () => fetch("/api/catalog").then(r => r.json()).then(d => setCatalogCodes(new Set((d.tests ?? []).map((t: { code: string }) => t.code)))).catch(() => undefined);
  useEffect(() => {
    void fetch("/api/builder/status").then(r => r.json()).then(setAi).catch(() => setAi({ ai: false, model: null }));
    void loadCatalog();
  }, []);

  const draft = async () => {
    setDrafting(true); setError(""); setDraftNote(""); setSaved(null);
    try {
      const res = await fetch("/api/builder/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not read the list.");
      setRows(data.rows.map((r: { code: string; name: string; sampleType?: string; unit?: string; price: number; loinc?: string }) => ({
        code: r.code, name: r.name, sampleType: r.sampleType ?? "", unit: r.unit ?? "", price: r.price ? String(r.price) : "", loinc: r.loinc ?? ""
      })));
      setDraftNote(`${data.rows.length} test(s) made ${data.source === "ai" ? "by Claude" : "by simple rules"}.${data.note ? ` ${data.note}` : ""}`);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not read the list."); } finally { setDrafting(false); }
  };

  const update = (i: number, key: keyof Row, value: string) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, [key]: key === "code" ? value.toUpperCase().replace(/\s+/g, "") : value } : r)));

  const codeCounts = rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.code]: (acc[r.code] ?? 0) + 1 }), {});
  const rowProblem = (r: Row) =>
    !CODE_RE.test(r.code) ? "Code: 2-30 capital letters, digits or -" :
    codeCounts[r.code] > 1 ? "Code used twice" :
    r.name.trim().length < 2 ? "Name needed" :
    r.price !== "" && !(Number(r.price) >= 0) ? "Price must be a number" : "";
  const problems = rows.map(rowProblem);
  const canSave = rows.length > 0 && problems.every(p => !p) && (!makePackage || (CODE_RE.test(pkg.code) && pkg.name.trim().length >= 2));

  const save = async () => {
    setSaving(true); setError(""); setSaved(null);
    try {
      const tests = rows.map(r => ({
        code: r.code, name: r.name.trim(), price: Number(r.price || 0),
        sampleType: r.sampleType.trim() || undefined, unit: r.unit.trim() || undefined, loinc: r.loinc.trim() || undefined
      }));
      const body = {
        tests,
        package: makePackage ? { code: pkg.code, name: pkg.name.trim(), price: Number(pkg.price || 0), testCodes: tests.map(t => t.code) } : undefined
      };
      const res = await fetch("/api/catalog/tests/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save.");
      setSaved(data);
      void loadCatalog();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save."); } finally { setSaving(false); }
  };

  const savedCodes = saved ? [...saved.created, ...saved.updated] : [];

  return <div className="content core-page flabs-theme">
    <div className="page-heading">
      <div>
        <div className="eyebrow">ONBOARDING</div>
        <h1>Test Builder</h1>
        <p>Add a lab's tests in one go, then link them to the lab's Flabs tests.</p>
      </div>
      <span className={`builder-ai ${ai?.ai ? "on" : "off"}`}><Sparkles size={14} /> {ai?.ai ? `AI on · ${ai.model}` : "AI off · simple rules"}</span>
    </div>

    {ai && !ai.ai && <div className="plain-hint"><Sparkles size={15} /><span>
      AI is off because <code>ANTHROPIC_API_KEY</code> is not set on the server. The builder still works: the list is split by simple rules and Flabs matches use codes and name words.
      Add the key in <code>.env.local</code> (locally) or Vercel → Environment Variables, then restart, to let Claude read free text and match tests by meaning.
    </span></div>}

    <section className="access-card">
      <div className="access-card-head"><div><h2>1. Write your tests</h2><p>One test per line or separated by commas. Add the price at the end if you have it. Codes are made for you.</p></div></div>
      <label className="field full"><span>Tests</span>
        <textarea className="builder-text" rows={6} value={text} onChange={e => setText(e.target.value)} placeholder={EXAMPLE} />
      </label>
      <div className="builder-actions">
        <Button variant="default" disabled={drafting || text.trim().length < 2} onClick={() => void draft()}><Wand2 size={15} /> {drafting ? "Reading…" : ai?.ai ? "Make rows with AI" : "Make rows"}</Button>
        <Button variant="outline" onClick={() => setText(EXAMPLE)}>Use example</Button>
        <Button variant="outline" onClick={() => setRows([...rows, blankRow()])}><Plus size={15} /> Add a row by hand</Button>
      </div>
      {draftNote && <div className="plain-hint"><Sparkles size={15} /><span>{draftNote}</span></div>}
    </section>

    {rows.length > 0 && <section className="access-card">
      <div className="access-card-head"><div><h2>2. Check and save</h2><p>Edit anything before saving. A code that already exists updates that test.{rows.some(r => r.loinc) ? " LOINC codes from AI are suggestions: check them." : ""}</p></div></div>
      <div className="access-table-wrap"><table className="access-table builder-table">
        <thead><tr><th>CODE *</th><th>NAME *</th><th>SAMPLE</th><th>UNIT</th><th>PRICE ₹</th><th>LOINC</th><th></th></tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className={problems[i] ? "has-problem" : ""}>
          <td><input value={r.code} onChange={e => update(i, "code", e.target.value)} placeholder="CBC" />{problems[i] ? <small className="builder-problem">{problems[i]}</small> : catalogCodes.has(r.code) ? <small className="builder-exists">updates existing</small> : <small className="builder-new">new</small>}</td>
          <td><input value={r.name} onChange={e => update(i, "name", e.target.value)} placeholder="Complete Blood Count" /></td>
          <td><input value={r.sampleType} onChange={e => update(i, "sampleType", e.target.value)} placeholder="Blood" /></td>
          <td><input value={r.unit} onChange={e => update(i, "unit", e.target.value)} placeholder="mg/dL" /></td>
          <td><input value={r.price} onChange={e => update(i, "price", e.target.value)} inputMode="decimal" placeholder="0" /></td>
          <td><input value={r.loinc} onChange={e => update(i, "loinc", e.target.value)} placeholder="optional" /></td>
          <td><Button variant="destructive" size="sm" aria-label={`Remove ${r.name || "row"}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 size={13} /></Button></td>
        </tr>)}</tbody>
      </table></div>

      <label className="auto-toggle" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={makePackage} onChange={e => setMakePackage(e.target.checked)} />
        <span>Also make a package of these {rows.length} tests</span>
      </label>
      {makePackage && <div className="form-grid">
        <label className="field"><span>Package code *</span><input value={pkg.code} onChange={e => setPkg({ ...pkg, code: e.target.value.toUpperCase().replace(/\s+/g, "") })} placeholder="FULL-BODY" /></label>
        <label className="field"><span>Package name *</span><input value={pkg.name} onChange={e => setPkg({ ...pkg, name: e.target.value })} placeholder="Full body checkup" /></label>
        <label className="field"><span>Package price ₹</span><input value={pkg.price} onChange={e => setPkg({ ...pkg, price: e.target.value })} inputMode="decimal" placeholder="0" /></label>
      </div>}

      <div className="builder-actions">
        <Button variant="default" disabled={saving || !canSave} onClick={() => void save()}><Save size={15} /> {saving ? "Saving…" : `Save ${rows.length} test${rows.length === 1 ? "" : "s"}`}</Button>
        <Button variant="outline" onClick={() => { setRows([]); setSaved(null); setDraftNote(""); }}>Clear</Button>
      </div>
      {saved && <div className={`access-message ${saved.errors.length ? "error" : "success"}`}>
        {saved.errors.length ? <X size={16} /> : <CheckCircle2 size={16} />}
        <span>{saved.created.length} created, {saved.updated.length} updated{saved.packageMessage ? `, ${saved.packageMessage}` : ""}.
          {saved.errors.length ? ` Skipped: ${saved.errors.map(e => `${e.code ?? `row ${e.row}`} (${e.error})`).join("; ")}` : " Now link them to Flabs below."}</span>
      </div>}
    </section>}

    <FlabsMatcher onlyCodes={savedCodes} aiOn={Boolean(ai?.ai)} />
  </div>;
}

/** Step 3: suggestions from Claude (or rules) for unmapped tests; staff tick the ones to keep. */
function FlabsMatcher({ onlyCodes, aiOn }: { onlyCodes: string[]; aiOn: boolean }) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [onlyNew, setOnlyNew] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ available: boolean; source?: string; note?: string; error?: string; flabsCount?: number; suggestions: Suggestion[] } | null>(null);
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState("");

  useEffect(() => {
    void fetch("/api/flabs/connections").then(r => r.json()).then(d => {
      const labs: Connection[] = (d.connections ?? []).filter((c: Connection) => !c.party);
      setConnections(labs);
      setConnectionId((labs.find(c => c.isDefault) ?? labs[0])?.id ?? "");
    }).catch(() => undefined);
  }, []);

  const find = async () => {
    setBusy(true); setMessage(""); setResult(null);
    try {
      const codes = onlyNew && onlyCodes.length ? onlyCodes : undefined;
      const res = await fetch(`/api/flabs/connections/${encodeURIComponent(connectionId)}/ai-match`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ codes })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not get matches.");
      setResult(data);
      // Sure matches are ticked; the rest wait for a person.
      setAccepted(Object.fromEntries((data.suggestions as Suggestion[]).map(s => [s.healjourCode, s.confidence === "high" && Boolean(s.flabsId)])));
    } catch (e) { setMessage(e instanceof Error ? e.message : "Could not get matches."); } finally { setBusy(false); }
  };

  const chosen = (result?.suggestions ?? []).filter(s => s.flabsId && accepted[s.healjourCode]);
  const saveMappings = async () => {
    setBusy(true); setMessage("");
    let ok = 0; const failed: string[] = [];
    for (const s of chosen) {
      const res = await fetch(`/api/flabs/connections/${encodeURIComponent(connectionId)}/mappings/test/${encodeURIComponent(s.healjourCode)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flabsId: s.flabsId })
      });
      if (res.ok) ok += 1; else failed.push(s.healjourCode);
    }
    setMessage(`${ok} mapping(s) saved.${failed.length ? ` Not saved: ${failed.join(", ")}.` : " These tests now go to Flabs by ID."}`);
    setBusy(false);
    if (ok) setResult(r => r ? { ...r, suggestions: r.suggestions.filter(s => !(accepted[s.healjourCode] && s.flabsId && !failed.includes(s.healjourCode))) } : r);
  };

  return <section className="access-card">
    <div className="access-card-head"><div><h2>3. Sync with Flabs</h2><p>{aiOn ? "Claude compares your tests with the lab's Flabs list by meaning (CBC = Hemogram) and explains each match." : "Matches come from codes and name words."} Nothing is saved until you tick and save.</p></div></div>
    {connections.length === 0 ? <p className="delivery-reason">Connect a Flabs lab account first (Test Catalog → Flabs CRM accounts).</p> : <>
      <div className="form-grid">
        <label className="field"><span>Flabs lab account</span>
          <select value={connectionId} onChange={e => { setConnectionId(e.target.value); setResult(null); }}>
            {connections.map(c => <option key={c.id} value={c.id}>{c.label}{c.isDefault ? " (default)" : ""}</option>)}
          </select>
        </label>
        <label className="auto-toggle" style={{ alignSelf: "end" }}>
          <input type="checkbox" checked={onlyNew} disabled={!onlyCodes.length} onChange={e => setOnlyNew(e.target.checked)} />
          <span>{onlyCodes.length ? `Only the ${onlyCodes.length} tests just saved` : "All unmapped tests in the catalog"}</span>
        </label>
      </div>
      <div className="builder-actions">
        <Button variant="default" disabled={busy || !connectionId} onClick={() => void find()}><Sparkles size={15} /> {busy && !result ? "Matching…" : aiOn ? "Find matches with AI" : "Find matches"}</Button>
      </div>
    </>}

    {result && !result.available && <div className="plain-hint"><Link2 size={15} /><span>{result.error} Map these tests by ID instead: Orders &amp; Bookings → Pre-booking → <b>Map</b> on each row.</span></div>}
    {result?.available && <>
      <div className="plain-hint"><Sparkles size={15} /><span>
        {result.suggestions.length} test(s) checked against {result.flabsCount} Flabs tests {result.source === "ai" ? "by Claude" : "by rules"}. Sure matches are ticked; check the others.{result.note ? ` ${result.note}` : ""}
      </span></div>
      {result.suggestions.length > 0 && <div className="access-table-wrap"><table className="access-table builder-table">
        <thead><tr><th></th><th>HEALJOUR TEST</th><th>FLABS TEST</th><th>MATCH</th><th>WHY</th></tr></thead>
        <tbody>{result.suggestions.map(s => <tr key={s.healjourCode}>
          <td><input type="checkbox" disabled={!s.flabsId} checked={Boolean(accepted[s.healjourCode])} onChange={e => setAccepted({ ...accepted, [s.healjourCode]: e.target.checked })} /></td>
          <td><b>{s.healjourName}</b><br /><code>{s.healjourCode}</code></td>
          <td>{s.flabsId ? <><b>{s.flabsName}</b><br /><code>{s.flabsCode || s.flabsId}</code>{s.flabsCost ? ` · ₹${s.flabsCost}` : ""}</> : <span className="muted">No match</span>}</td>
          <td><span className={`builder-confidence ${s.confidence}`}>{s.confidence === "none" ? "none" : s.confidence}</span></td>
          <td className="builder-reason">{s.reason}</td>
        </tr>)}</tbody>
      </table></div>}
      {result.suggestions.length > 0 && <div className="builder-actions">
        <Button variant="default" disabled={busy || chosen.length === 0} onClick={() => void saveMappings()}><Save size={15} /> Save {chosen.length} mapping{chosen.length === 1 ? "" : "s"}</Button>
      </div>}
    </>}
    {message && <div className="access-message success"><CheckCircle2 size={16} />{message}</div>}
  </section>;
}
