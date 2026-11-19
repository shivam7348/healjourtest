import { useEffect, useMemo, useState } from "react";
import { Copy, Plus, RefreshCw, Save, Search, Trash2, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export type FlabsCorporate = { id: string; name: string };
export type CorporateMapping = { healjourName: string; healjourCode?: string; flabsId: string; flabsName: string };
type CorporatesResponse = { branchId: string | null; corporates: FlabsCorporate[]; mappings: CorporateMapping[]; error?: string; fetchedAt?: string };
type Row = { healjourName: string; healjourCode: string; flabsId: string };
type Test = { _id: string; name: string; code: string; cost: number };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Loads a Flabs account's corporates and the saved Healjour → Flabs corporate mapping. */
export async function fetchCorporates(connectionId: string): Promise<CorporatesResponse> {
  const res = await fetch(`/api/flabs/connections/${encodeURIComponent(connectionId)}/corporates`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Could not load corporates.");
  return data;
}

/**
 * Corporates of one Flabs account (GET /client/crm/corporates): see each corporate's own test prices,
 * and map Healjour's corporate clients to them. The mapped Flabs ID is sent as corporateUser on bookings.
 */
export default function FlabsCorporates({ connectionId }: { connectionId: string }) {
  const [data, setData] = useState<CorporatesResponse | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [query, setQuery] = useState("");
  const [prices, setPrices] = useState<{ corporate: FlabsCorporate; tests?: Test[]; error?: string; filter: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = async () => {
    setBusy(true); setError("");
    try {
      const d = await fetchCorporates(connectionId);
      setData(d);
      setRows(d.mappings.map(m => ({ healjourName: m.healjourName, healjourCode: m.healjourCode ?? "", flabsId: m.flabsId })));
      if (d.error) setError(d.error);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load corporates."); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, [connectionId]);

  const corporates = data?.corporates ?? [];
  const byId = useMemo(() => new Map(corporates.map(c => [c.id, c])), [corporates]);
  const mappedIds = new Set(rows.map(r => r.flabsId).filter(Boolean));
  const q = query.trim().toLowerCase();
  const shown = corporates.filter(c => !q || c.name.toLowerCase().includes(q) || c.id.includes(q));

  const autoMatch = () => {
    const added = corporates.filter(c => !mappedIds.has(c.id) && !rows.some(r => norm(r.healjourName) === norm(c.name)));
    const filled = rows.map(r => r.flabsId ? r : { ...r, flabsId: corporates.find(c => norm(c.name) === norm(r.healjourName))?.id ?? "" });
    setRows([...filled, ...added.map(c => ({ healjourName: c.name, healjourCode: "", flabsId: c.id }))]);
    setNotice(`${added.length} corporate(s) added with the same name. Rename the Healjour side if your name differs, then Save.`);
  };

  const save = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const clean = rows.filter(r => r.healjourName.trim() && r.flabsId);
      const res = await fetch(`/api/flabs/connections/${encodeURIComponent(connectionId)}/corporate-mappings`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mappings: clean.map(r => ({ healjourName: r.healjourName.trim(), healjourCode: r.healjourCode.trim() || undefined, flabsId: r.flabsId, flabsName: byId.get(r.flabsId)?.name })) })
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Could not save.");
      setNotice(`${d.mappings.length} corporate mapping(s) saved. They appear in the booking form's corporate list.`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save."); }
    finally { setBusy(false); }
  };

  const viewPrices = async (corporate: FlabsCorporate) => {
    if (prices?.corporate.id === corporate.id) { setPrices(null); return; }
    setPrices({ corporate, filter: "" });
    try {
      const res = await fetch(`/api/flabs/connections/${encodeURIComponent(connectionId)}/tests?corporateUser=${encodeURIComponent(corporate.id)}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Flabs did not return tests.");
      setPrices({ corporate, tests: d.tests, filter: "" });
    } catch (e) { setPrices({ corporate, error: e instanceof Error ? e.message : "Could not load prices.", filter: "" }); }
  };

  const update = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const priceRows = prices?.tests?.filter(t => !prices.filter || t.name.toLowerCase().includes(prices.filter.toLowerCase()) || (t.code ?? "").toLowerCase().includes(prices.filter.toLowerCase())) ?? [];

  return <div className="corp-panel">
    <div className="corp-head">
      <div><b>Corporates in Flabs</b><small>{data?.branchId ? `Branch ${data.branchId}` : ""}{data?.fetchedAt ? ` · ${corporates.length} active` : ""}</small></div>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void load()}><RefreshCw size={13} className={busy ? "spin" : ""} /> Refresh</Button>
    </div>
    {error && <div className="access-message error"><X size={16} />{error}</div>}
    {notice && <div className="access-message success">{notice}</div>}

    {corporates.length > 0 && <>
      <label className="corp-search"><Search size={14} /><input placeholder="Search corporates" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <ul className="corp-list">{shown.map(c => <li key={c.id}>
        <span><b>{c.name}</b><code>{c.id}</code></span>
        {mappedIds.has(c.id) && <span className="corp-pill">Mapped</span>}
        <button type="button" className="corp-icon" title="Copy ID" onClick={() => void navigator.clipboard?.writeText(c.id)}><Copy size={13} /></button>
        <Button variant="outline" size="sm" onClick={() => void viewPrices(c)}>{prices?.corporate.id === c.id ? "Hide prices" : "View prices"}</Button>
      </li>)}</ul>
    </>}
    {data && !error && corporates.length === 0 && <p className="corp-empty">This branch has no active corporates in Flabs.</p>}

    {prices && <div className="corp-prices">
      <div className="corp-head"><div><b>Prices for {prices.corporate.name}</b><small>{prices.tests ? `${prices.tests.length} tests` : "Loading…"}</small></div>
        {prices.tests && <label className="corp-search"><Search size={14} /><input placeholder="Search tests" value={prices.filter} onChange={e => setPrices({ ...prices, filter: e.target.value })} /></label>}</div>
      {prices.error && <div className="access-message error"><X size={16} />{prices.error}</div>}
      {prices.tests && <div className="corp-table-wrap"><table className="corp-table">
        <thead><tr><th>Test</th><th>Code</th><th>Price (₹)</th></tr></thead>
        <tbody>{priceRows.slice(0, 100).map(t => <tr key={t._id}><td>{t.name}</td><td><code>{t.code || "—"}</code></td><td>{t.cost}</td></tr>)}</tbody>
      </table>{priceRows.length > 100 && <small className="corp-empty">Showing 100 of {priceRows.length}. Search to narrow down.</small>}</div>}
    </div>}

    <div className="corp-head corp-map-head">
      <div><b>Healjour → Flabs corporate mapping</b><small>Bookings for a Healjour corporate client go to Flabs with the mapped corporate (corporateUser), so its prices apply.</small></div>
      <div className="corp-actions">
        <Button variant="outline" size="sm" disabled={!corporates.length} onClick={autoMatch}><Wand2 size={13} /> Auto-match by name</Button>
        <Button variant="outline" size="sm" onClick={() => setRows([...rows, { healjourName: "", healjourCode: "", flabsId: "" }])}><Plus size={13} /> Add row</Button>
      </div>
    </div>
    {rows.length === 0 ? <p className="corp-empty">No mapping yet. Use Auto-match or Add row.</p> : <div className="corp-table-wrap"><table className="corp-table">
      <thead><tr><th>Healjour corporate client</th><th>Healjour code (optional)</th><th>Flabs corporate</th><th /></tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>
        <td><input value={r.healjourName} onChange={e => update(i, { healjourName: e.target.value })} placeholder="e.g. Acme Technologies" /></td>
        <td><input value={r.healjourCode} onChange={e => update(i, { healjourCode: e.target.value })} placeholder="e.g. ACME" /></td>
        <td><select value={r.flabsId} onChange={e => update(i, { flabsId: e.target.value })}>
          <option value="">Choose…</option>
          {corporates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          {r.flabsId && !byId.has(r.flabsId) && <option value={r.flabsId}>{r.flabsId} (not active in Flabs)</option>}
        </select></td>
        <td><button type="button" className="corp-icon danger" aria-label="Remove row" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 size={13} /></button></td>
      </tr>)}</tbody>
    </table></div>}
    <div className="builder-actions"><Button variant="default" size="sm" disabled={busy} onClick={() => void save()}><Save size={13} /> Save mapping</Button></div>
  </div>;
}
