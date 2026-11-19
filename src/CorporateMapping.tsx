import { useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, Save, Search, Trash2, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchCorporates, type CorporateMapping, type FlabsCorporate } from "./FlabsCorporates";

type Account = { id: string; label: string; branchId: string | null };
type AccountData = { account: Account; corporates: FlabsCorporate[]; mappings: CorporateMapping[]; error?: string };
/** One Healjour corporate client and, per Flabs account, the Flabs corporate it maps to ("" = not in that account). */
type Row = { key: string; healjourName: string; healjourCode: string; byAccount: Record<string, string> };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const rowKey = (name: string, code: string) => norm(code || name);

/**
 * Corporate mapping across every Flabs account. A Healjour corporate client can sit in several labs,
 * each with its own Flabs corporate ID; the booking form sends the ID of the account the booking goes to.
 */
export default function CorporateMapping() {
  const [accounts, setAccounts] = useState<AccountData[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const res = await fetch("/api/flabs/connections");
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "Could not load Flabs accounts.");
      const list: Account[] = d.connections.map((c: Account) => ({ id: c.id, label: c.label, branchId: c.branchId }));
      const data = await Promise.all(list.map(async account => {
        try { const x = await fetchCorporates(account.id); return { account, corporates: x.corporates, mappings: x.mappings, error: x.error }; }
        catch (e) { return { account, corporates: [], mappings: [], error: e instanceof Error ? e.message : "Could not load." }; }
      }));
      setAccounts(data);
      // Rows: every Healjour corporate client mapped in any account, merged by code (or name).
      const merged = new Map<string, Row>();
      for (const a of data) for (const m of a.mappings) {
        const key = rowKey(m.healjourName, m.healjourCode ?? "");
        const row = merged.get(key) ?? { key, healjourName: m.healjourName, healjourCode: m.healjourCode ?? "", byAccount: {} };
        row.byAccount[a.account.id] = m.flabsId;
        merged.set(key, row);
      }
      setRows([...merged.values()].sort((x, y) => x.healjourName.localeCompare(y.healjourName)));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load."); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);

  const corpName = useMemo(() => new Map(accounts.flatMap(a => a.corporates.map(c => [`${a.account.id}:${c.id}`, c.name] as const))), [accounts]);
  const update = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setCell = (i: number, accountId: string, flabsId: string) => setRows(rows.map((r, j) => (j === i ? { ...r, byAccount: { ...r.byAccount, [accountId]: flabsId } } : r)));

  /** Same corporate name in several accounts becomes one Healjour row with each account's ID filled in. */
  const autoMatch = () => {
    const next = rows.map(r => ({ ...r, byAccount: { ...r.byAccount } }));
    let added = 0, filled = 0;
    for (const a of accounts) for (const c of a.corporates) {
      let row = next.find(r => norm(r.healjourName) === norm(c.name));
      if (!row) { row = { key: `new-${norm(c.name)}`, healjourName: c.name, healjourCode: "", byAccount: {} }; next.push(row); added++; }
      if (!row.byAccount[a.account.id]) { row.byAccount[a.account.id] = c.id; filled++; }
    }
    setRows(next.sort((x, y) => x.healjourName.localeCompare(y.healjourName)));
    setNotice(`${added} Healjour corporate(s) added, ${filled} account link(s) filled by name. Check them, then Save.`);
  };

  const save = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const names = rows.map(r => rowKey(r.healjourName, r.healjourCode));
      if (rows.some(r => r.healjourName.trim().length < 2)) throw new Error("Every row needs a Healjour corporate name (2+ letters).");
      if (new Set(names).size !== names.length) throw new Error("Two rows have the same Healjour name or code. Merge them first.");
      const results = await Promise.all(accounts.filter(a => !a.error || a.mappings.length || rows.some(r => r.byAccount[a.account.id])).map(async a => {
        const mappings = rows.filter(r => r.byAccount[a.account.id]).map(r => ({
          healjourName: r.healjourName.trim(), healjourCode: r.healjourCode.trim() || undefined,
          flabsId: r.byAccount[a.account.id], flabsName: corpName.get(`${a.account.id}:${r.byAccount[a.account.id]}`)
        }));
        const res = await fetch(`/api/flabs/connections/${encodeURIComponent(a.account.id)}/corporate-mappings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mappings }) });
        const d = await res.json();
        return res.ok ? `${a.account.label}: ${d.mappings.length}` : `${a.account.label}: ${d.error ?? "failed"}`;
      }));
      setNotice(`Saved. ${results.join(" · ")}`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save."); }
    finally { setBusy(false); }
  };

  const q = query.trim().toLowerCase();
  const shown = rows.map((r, i) => ({ r, i })).filter(({ r }) => !q || r.healjourName.toLowerCase().includes(q) || r.healjourCode.toLowerCase().includes(q));

  return <div className="content core-page flabs-theme">
    <div className="page-heading">
      <div><div className="eyebrow">FLABS · CORPORATES</div><h1>Corporate mapping</h1>
        <p>Map each Healjour corporate client to its corporate in every Flabs account. A booking sends the corporate ID of the account it goes to, so that lab's corporate prices apply.</p></div>
      <div className="heading-actions">
        <Button variant="outline" disabled={busy} onClick={() => void load()}><RefreshCw size={15} className={busy ? "spin" : ""} /> Refresh</Button>
        <Button variant="default" disabled={busy || !accounts.length} onClick={() => void save()}><Save size={15} /> Save all</Button>
      </div>
    </div>
    {error && <div className="access-message error"><X size={16} />{error}</div>}
    {notice && <div className="access-message success">{notice}</div>}

    <div className="cm-accounts">{accounts.map(a => <div key={a.account.id} className={a.error ? "bad" : ""}>
      <b>{a.account.label}</b>
      <small>{a.error ? a.error : `${a.corporates.length} corporate(s) in Flabs · ${a.mappings.length} mapped`}</small>
    </div>)}
      {!accounts.length && !busy && <p className="corp-empty">No Flabs account connected. Add one in Test Catalog.</p>}
    </div>

    <section className="access-card">
      <div className="corp-head">
        <label className="corp-search"><Search size={14} /><input placeholder="Search Healjour corporates" value={query} onChange={e => setQuery(e.target.value)} /></label>
        <div className="corp-actions">
          <Button variant="outline" size="sm" disabled={!accounts.some(a => a.corporates.length)} onClick={autoMatch}><Wand2 size={13} /> Auto-match by name</Button>
          <Button variant="outline" size="sm" onClick={() => setRows([...rows, { key: `new-${Date.now()}`, healjourName: "", healjourCode: "", byAccount: {} }])}><Plus size={13} /> Add corporate</Button>
        </div>
      </div>
      {rows.length === 0 ? <p className="corp-empty">No corporates mapped yet. Use Auto-match by name, or Add corporate.</p> :
        <div className="corp-table-wrap cm-wrap"><table className="corp-table cm-table">
          <thead><tr><th>Healjour corporate client</th><th>Code</th>{accounts.map(a => <th key={a.account.id}>{a.account.label}</th>)}<th /></tr></thead>
          <tbody>{shown.map(({ r, i }) => <tr key={r.key}>
            <td><input value={r.healjourName} onChange={e => update(i, { healjourName: e.target.value })} placeholder="e.g. Acme Technologies" /></td>
            <td><input value={r.healjourCode} onChange={e => update(i, { healjourCode: e.target.value })} placeholder="ACME" /></td>
            {accounts.map(a => <td key={a.account.id}>
              <select value={r.byAccount[a.account.id] ?? ""} onChange={e => setCell(i, a.account.id, e.target.value)} disabled={!a.corporates.length && !r.byAccount[a.account.id]}>
                <option value="">— not in this lab —</option>
                {a.corporates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                {r.byAccount[a.account.id] && !a.corporates.some(c => c.id === r.byAccount[a.account.id]) && <option value={r.byAccount[a.account.id]}>{r.byAccount[a.account.id]} (not active)</option>}
              </select>
            </td>)}
            <td><button type="button" className="corp-icon danger" aria-label="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 size={13} /></button></td>
          </tr>)}</tbody>
        </table></div>}
      <small className="corp-empty">Saving replaces each account's mapping with this table. A row left as "not in this lab" is not sent for bookings to that account.</small>
    </section>
  </div>;
}
