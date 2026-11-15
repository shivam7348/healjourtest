import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, fmtDate, STATUS_LABEL, type CaseStatus, type CaseSummary, type PortalLab, type Role } from "./api";
import { CaseDetail, StatusChip } from "./CaseDetail";

/** Case list with status tabs and a detail panel. Labs see their own cases; Healjour sees all, with a lab filter. */
export function CasesBoard({ role, labs, reloadKey }: { role: Role; labs?: PortalLab[]; reloadKey?: number }) {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [status, setStatus] = useState<"" | CaseStatus | "open">("open");
  const [labId, setLabId] = useState("");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const admin = role === "healjour_admin";

  const load = async () => {
    try {
      const qs = new URLSearchParams();
      if (labId) qs.set("labId", labId);
      const data = await api<{ cases: CaseSummary[] }>(`/api/portal/cases?${qs}`);
      setCases(data.cases); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load cases."); }
  };
  useEffect(() => { void load(); }, [labId, reloadKey]);
  // New bookings and lab updates show up without a reload.
  useEffect(() => { const t = setInterval(() => void load(), 30_000); return () => clearInterval(t); }, [labId]);

  const counts = cases.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }), {});
  const open = cases.filter(c => !["completed", "rejected", "cancelled"].includes(c.status));
  const q = query.trim().toLowerCase();
  const shown = (status === "open" ? open : status ? cases.filter(c => c.status === status) : cases)
    .filter(c => !q || c.caseNo.toLowerCase().includes(q) || c.patient.name.toLowerCase().includes(q) || c.tests.some(t => t.name.toLowerCase().includes(q)));

  return <div className={`cases-board ${openId ? "has-detail" : ""}`}>
    <div className="cases-list">
      <div className="cases-toolbar">
        <div className="segmented-tabs">
          {([["open", `Open (${open.length})`], ["", `All (${cases.length})`], ...(["new", "processing", "report_ready", "completed"] as CaseStatus[]).map(s => [s, `${STATUS_LABEL[s]} (${counts[s] ?? 0})`])] as Array<[string, string]>).map(([v, label]) =>
            <button key={v || "all"} type="button" className={status === v ? "on" : ""} onClick={() => setStatus(v as typeof status)}>{label}</button>)}
        </div>
        <div className="cases-filters">
          {admin && labs && <select value={labId} onChange={e => setLabId(e.target.value)}><option value="">All labs</option>{labs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select>}
          <input className="list-search" placeholder="Search case, patient or test" value={query} onChange={e => setQuery(e.target.value)} />
          <Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw size={13} /> Refresh</Button>
        </div>
      </div>
      {error && <p className="delivery-reason">{error}</p>}
      {shown.length === 0 ? <div className="empty-state"><b>No cases here</b><p>{admin ? "Send a booking to a lab to start." : "New bookings from Healjour will appear here."}</p></div> :
        <div className="access-table-wrap"><table className="access-table cases-table">
          <thead><tr><th>CASE</th><th>PATIENT</th><th>TESTS</th>{admin && <th>LAB</th>}<th>STATUS</th><th>UPDATED</th></tr></thead>
          <tbody>{shown.map(c => <tr key={c.id} className={`${openId === c.id ? "is-open" : ""} ${admin && c.unseen ? "is-unseen" : ""}`} onClick={() => setOpenId(c.id)}>
            <td><b>{c.caseNo}</b>{c.priority !== "routine" && <span className={`prio ${c.priority}`}>{c.priority}</span>}{admin && c.unseen && <span className="unseen-dot" title="New update from the lab" />}</td>
            <td>{c.patient.name}<br /><small className="muted">{c.patient.gender}, {c.patient.age} {c.patient.ageUnit}</small></td>
            <td>{c.tests.slice(0, 2).map(t => t.code).join(", ")}{c.tests.length > 2 ? ` +${c.tests.length - 2}` : ""}</td>
            {admin && <td>{c.labName}</td>}
            <td><StatusChip status={c.status} />{c.reportCount > 0 && <small className="muted"> · {c.reportCount} report</small>}</td>
            <td><small>{fmtDate(c.updatedAt)}</small></td>
          </tr>)}</tbody>
        </table></div>}
    </div>
    {openId && <CaseDetail caseId={openId} role={role} onChanged={() => void load()} onClose={() => setOpenId(null)} />}
  </div>;
}
