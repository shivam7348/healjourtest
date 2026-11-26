import { useEffect, useMemo, useState } from "react";
import { Download, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";

type Param = { name: string; value: string };
type TestResult = { testName: string; status: string; parameters: Param[] };
type Record_ = {
  id: string; integratorID: string; leadId?: string; account: string; patientName: string; contact: string;
  reportUrl?: string; tests?: TestResult[]; receivedAt: string; updatedAt: string;
  workspace?: { id: string; tenantId: string; name: string } | null;
};
type Row = {
  received: string; patient: string; contact: string; account: string; workspace: string; bill: string; integratorID: string;
  test: string; testStatus: string; parameter: string; value: string; report: string;
};

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** One row per parameter value, so results can be searched, sorted and exported like a table. */
function toRows(list: Record_[]): Row[] {
  return list.flatMap(r => (r.tests ?? []).flatMap(t => {
    const base = {
      received: r.receivedAt, patient: r.patientName || "—", contact: r.contact || "", account: r.account,
      workspace: r.workspace ? `${r.workspace.tenantId} · ${r.workspace.name}` : "",
      bill: r.id, integratorID: r.integratorID, test: t.testName, testStatus: t.status || "", report: r.reportUrl ?? ""
    };
    if (!t.parameters.length) return [{ ...base, parameter: "—", value: "—" }];
    return t.parameters.map(p => ({ ...base, parameter: p.name, value: p.value || "—" }));
  }));
}

const csvCell = (v: string) => `"${String(v).replace(/"/g, '""')}"`;

/**
 * Results tool: every Flabs result and report Healjour has received, saved in its database.
 * Search, filter, export to CSV, and copy in older results from the booking tracker.
 */
export default function FlabsResults() {
  const [records, setRecords] = useState<Record_[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const res = await fetch("/api/flabs/results");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load results.");
      setRecords(data.records);
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load results."); }
  };
  useEffect(() => { void load(); const t = setInterval(() => void load(), 30000); return () => clearInterval(t); }, []);

  const rows = useMemo(() => toRows(records), [records]);
  const q = query.trim().toLowerCase();
  const shown = rows.filter(r => !q || [r.patient, r.contact, r.bill, r.integratorID, r.test, r.parameter, r.value, r.account].some(v => v.toLowerCase().includes(q)));

  const backfill = async () => {
    setBusy(true); setNotice(""); setError("");
    try {
      const res = await fetch("/api/flabs/results/backfill", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save.");
      setNotice(data.message);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save."); }
    finally { setBusy(false); }
  };

  // Reference ranges: one line per parameter, "name | unit | low | high". Empty low/high = not flagged on that side.
  const [showRanges, setShowRanges] = useState(false);
  const [rangesText, setRangesText] = useState("");
  const [rangesBusy, setRangesBusy] = useState(false);
  const loadRanges = async () => {
    const res = await fetch("/api/flabs/parameter-ranges");
    const data = await res.json();
    if (res.ok) setRangesText((data.ranges as Array<{ name: string; unit?: string; low?: number; high?: number }>).map(r => [r.name, r.unit ?? "", r.low ?? "", r.high ?? ""].join(" | ")).join("\n"));
  };
  const saveRanges = async () => {
    setRangesBusy(true); setError(""); setNotice("");
    try {
      const ranges = rangesText.split("\n").map(l => l.trim()).filter(Boolean).map(l => {
        const [name, unit, low, high] = l.split("|").map(s => s.trim());
        const lo = low ? Number(low) : undefined;
        const hi = high ? Number(high) : undefined;
        return { name, unit: unit || undefined, low: Number.isFinite(lo) ? lo : undefined, high: Number.isFinite(hi) ? hi : undefined };
      });
      const res = await fetch("/api/flabs/parameter-ranges", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ranges }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save the ranges.");
      setNotice(`${ranges.length} reference range(s) saved. Smart reports use them from now on.`);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save the ranges."); }
    finally { setRangesBusy(false); }
  };

  const exportCsv = () => {
    const header = ["Received", "Patient", "Contact", "Account", "Workspace", "Bill ID", "Booking ID", "Test", "Test status", "Parameter", "Value", "Report URL"];
    const lines = shown.map(r => [r.received, r.patient, r.contact, r.account, r.workspace, r.bill, r.integratorID, r.test, r.testStatus, r.parameter, r.value, r.report].map(csvCell).join(","));
    const blob = new Blob(["﻿" + [header.map(csvCell).join(","), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `flabs-results-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return <section className="fres">
    {error && <div className="access-message error">{error}</div>}
    {notice && <div className="access-message success">{notice}</div>}

    <div className="fres-bar">
      <label className="fres-search"><Search size={14} /><input placeholder="Search patient, mobile, bill ID, test or parameter" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <div className="fres-actions">
        <span className="fres-count">{records.length} report(s) · {shown.length} row(s)</span>
        <Button variant="outline" size="sm" onClick={() => void backfill()} disabled={busy}><RefreshCw size={13} /> {busy ? "Saving…" : "Save older results"}</Button>
        <Button variant="default" size="sm" onClick={exportCsv} disabled={shown.length === 0}><Download size={13} /> Export CSV</Button>
        <Button variant="outline" size="sm" onClick={() => { setShowRanges(v => !v); if (!showRanges) void loadRanges(); }}>{showRanges ? "Hide ranges" : "Reference ranges"}</Button>
      </div>
    </div>

    {showRanges && <div className="fres-ranges">
      <b>Reference ranges for smart reports</b>
      <small>One parameter per line: <code>name | unit | low | high</code>. Example: <code>Haemoglobin | g/dL | 12 | 16</code>. Leave low or high empty to flag only one side. Parameters without a line are shown without a flag.</small>
      <textarea rows={6} value={rangesText} onChange={e => setRangesText(e.target.value)} placeholder={"Haemoglobin | g/dL | 12 | 16\nTotal WBC Count | /cumm | 4000 | 11000"} />
      <div className="fres-actions"><Button variant="default" size="sm" onClick={() => void saveRanges()} disabled={rangesBusy}>{rangesBusy ? "Saving…" : "Save ranges"}</Button></div>
    </div>}

    <div className="fres-table-wrap">
      <table className="fres-table">
        <thead><tr><th>Received</th><th>Patient</th><th>Bill ID</th><th>Test</th><th>Parameter</th><th>Value</th><th>Lab report</th><th>Smart report</th></tr></thead>
        <tbody>
          {shown.length === 0 && <tr><td colSpan={8} className="fres-empty">No results yet. Results appear here when Flabs sends a completed bill, and are saved in the database.</td></tr>}
          {shown.map((r, i) => <tr key={i}>
            <td>{when(r.received)}</td>
            <td><b>{r.patient}</b><small>{r.contact}</small></td>
            <td><code>{r.bill}</code><small>{r.account}</small>{r.workspace && <span className="ws-tag">{r.workspace}</span>}</td>
            <td>{r.test}<small>{r.testStatus}</small></td>
            <td>{r.parameter}</td>
            <td><b>{r.value}</b></td>
            <td>{r.report ? <a href={r.report} target="_blank" rel="noopener noreferrer" className="log-link">Open</a> : <span className="muted">—</span>}</td>
            <td><a href={`/api/flabs/results/${encodeURIComponent(r.bill)}/smart-report`} target="_blank" rel="noopener noreferrer" className="fres-smart">Open smart report</a></td>
          </tr>)}
        </tbody>
      </table>
    </div>
  </section>;
}
