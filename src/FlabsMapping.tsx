import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, RefreshCw, Save, Trash2, X } from "lucide-react";

type FlabsTest = { _id: string; name: string; code: string; cost: number };
type Suggestion = FlabsTest;
type HealjourTest = {
  code: string; name: string; loinc: string | null; price: number;
  mapping: { flabsId: string; flabsCode: string; flabsName: string; flabsCost: number; source: "auto" | "manual" } | null;
  suggestions: Suggestion[];
};
type View = { branchId: string; party: { field: string; id: string } | null; healjourTests: HealjourTest[]; flabsTests: FlabsTest[] };

/**
 * Maps each Healjour test to one Flabs test of the chosen account.
 * Suggestions come from matching names; staff can always pick any Flabs test from the full list.
 */
export default function FlabsMapping({ connectionId, label, onChanged, onClose }: {
  connectionId: string; label: string; onChanged: () => void; onClose: () => void;
}) {
  const [view, setView] = useState<View | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = async () => {
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/flabs/connections/${connectionId}/mapping-view`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load Flabs tests.");
      setView(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load Flabs tests.");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { void load(); }, [connectionId]);

  const mappedCount = view?.healjourTests.filter(t => t.mapping).length ?? 0;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (view?.healjourTests ?? []).filter(t => !q || t.name.toLowerCase().includes(q) || t.code.toLowerCase().includes(q));
  }, [view, search]);

  const save = async (code: string, flabsId: string) => {
    if (!flabsId) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const res = await fetch(`/api/flabs/connections/${connectionId}/mappings/test/${encodeURIComponent(code)}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flabsId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save mapping.");
      setNotice(data.message);
      setPicked(p => { const next = { ...p }; delete next[code]; return next; });
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save mapping.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (code: string) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const res = await fetch(`/api/flabs/connections/${connectionId}/mappings/test/${encodeURIComponent(code)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not remove mapping.");
      setNotice(data.message);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove mapping.");
    } finally {
      setBusy(false);
    }
  };

  const autoMatch = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const res = await fetch(`/api/flabs/connections/${connectionId}/sync`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Auto-match failed.");
      setNotice(`Auto-match: ${data.matched.length} test(s) matched by code. Your manual choices are kept.`);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Auto-match failed.");
    } finally {
      setBusy(false);
    }
  };

  return <section className="flabs-mapping">
    <div className="access-card-head">
      <div>
        <h2>Map Healjour tests to Flabs: {label}</h2>
        <p>{mappedCount} of {view?.healjourTests.length ?? 0} mapped. Pick the Flabs test for each Healjour test. Unmapped tests are sent to Flabs by name.</p>
      </div>
      <div className="heading-actions">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void autoMatch()}><RefreshCw size={13} /> Auto-match by code</Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>Close</Button>
      </div>
    </div>

    <div className="form-grid">
      <label className="field"><span>Search Healjour tests</span><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Name or code" /></label>
    </div>

    {error && <div className="access-message error"><X size={16} />{error}<Button className="h-auto" variant="ghost" onClick={() => setError("")}>Dismiss</Button></div>}
    {notice && <div className="access-message success"><CheckCircle2 size={16} />{notice}<Button className="h-auto" variant="ghost" onClick={() => setNotice("")}>Dismiss</Button></div>}

    <div className="access-table-wrap"><table className="access-table mapping-table-wide">
      <thead><tr><th>HEALJOUR TEST</th><th>FLABS TEST</th><th>STATUS</th><th /></tr></thead>
      <tbody>
        {visible.map(t => {
          const choice = picked[t.code] ?? t.mapping?.flabsId ?? "";
          return <tr key={t.code}>
            <td><b>{t.name}</b><small><code>{t.code}</code>{t.loinc ? ` · LOINC ${t.loinc}` : ""}</small></td>
            <td>
              <FlabsPicker tests={view?.flabsTests ?? []} value={choice} disabled={busy} onChange={id => setPicked(p => ({ ...p, [t.code]: id }))} />
              {!t.mapping && t.suggestions.length > 0 && <div className="suggestions">
                <small>Suggested:</small>
                {t.suggestions.map(s => <Button variant="ghost" key={s._id} className="h-auto suggestion-chip" onClick={() => setPicked(p => ({ ...p, [t.code]: s._id }))}>{s.name} ({s.code || "—"})</Button>)}
              </div>}
            </td>
            <td>
              {t.mapping
                ? <span className={`access-status ${t.mapping.source === "manual" ? "approved" : "active"}`}>{t.mapping.source === "manual" ? "Manual" : "Auto"} · ₹{t.mapping.flabsCost}</span>
                : <span className="access-status pending">Not mapped</span>}
            </td>
            <td className="mapping-actions">
              <Button variant="default" size="sm" disabled={busy || !choice || choice === t.mapping?.flabsId} onClick={() => void save(t.code, choice)}><Save size={13} /> Save</Button>
              {t.mapping && <Button variant="destructive" size="sm" disabled={busy} onClick={() => void remove(t.code)}><Trash2 size={13} /></Button>}
            </td>
          </tr>;
        })}
      </tbody>
    </table></div>
  </section>;
}

/** Type to search this account's Flabs tests; matching tests appear in a list under the box. */
function FlabsPicker({ tests, value, onChange, disabled }: { tests: FlabsTest[]; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const selected = tests.find(t => t._id === value);
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return tests.slice(0, 8);
    return tests.filter(t => t.name.toLowerCase().includes(q) || (t.code ?? "").toLowerCase().includes(q)).slice(0, 8);
  }, [tests, q]);

  return <div className="flabs-picker">
    <input
      className="flabs-picker-input"
      disabled={disabled}
      value={open ? query : selected ? `${selected.name} · ${selected.code || "no code"} · ₹${selected.cost}` : query}
      placeholder="Type a Flabs test name or code…"
      onFocus={() => { setOpen(true); setQuery(""); }}
      onBlur={() => setTimeout(() => setOpen(false), 150)}
      onChange={e => { setQuery(e.target.value); setOpen(true); }}
    />
    {open && <div className="flabs-picker-list">
      {matches.length === 0 && <div className="flabs-picker-empty">No Flabs test matches "{query}"</div>}
      {matches.map(t => <Button variant="ghost" key={t._id} className={cn("h-auto", `flabs-picker-item ${t._id === value ? "is-selected" : ""}`)} onMouseDown={e => { e.preventDefault(); onChange(t._id); setOpen(false); setQuery(""); }}>
        <span>{t.name}</span><small>{t.code || "no code"} · ₹{t.cost}</small>
      </Button>)}
      {!q && tests.length > 8 && <div className="flabs-picker-empty">Type to see more of the {tests.length} tests</div>}
    </div>}
  </div>;
}
