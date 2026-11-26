import { useEffect, useState } from "react";
import { CheckCircle2, ClipboardList, FileText, FlaskConical, Inbox, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, fmtDate, type CaseStatus, type CaseSummary, type PortalLab, type Role } from "./api";
import { CaseDetail, StatusChip } from "./CaseDetail";
import { CreatedBy, WorkspaceTag } from "../lib/record-tags";

type Filter = "open" | "new" | "progress" | "report_ready" | "done" | "all";
const IN_PROGRESS: CaseStatus[] = ["accepted", "sample_collected", "processing"];
const CLOSED: CaseStatus[] = ["completed", "rejected", "cancelled"];

const matchesFilter = (c: CaseSummary, f: Filter) =>
  f === "all" ? true :
  f === "open" ? !CLOSED.includes(c.status) :
  f === "new" ? c.status === "new" :
  f === "progress" ? IN_PROGRESS.includes(c.status) :
  f === "report_ready" ? c.status === "report_ready" :
  CLOSED.includes(c.status);

const shortAge = (c: CaseSummary) => `${c.patient.gender[0]?.toUpperCase() ?? ""} · ${c.patient.age}${c.patient.ageUnit === "year" ? "y" : c.patient.ageUnit === "month" ? "m" : "d"}`;

/** Case list with count cards (which also filter) and a detail panel. Labs see their own cases; Healjour sees all. */
export function CasesBoard({ role, labs, reloadKey }: { role: Role; labs?: PortalLab[]; reloadKey?: number }) {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [filter, setFilter] = useState<Filter>("open");
  const [labId, setLabId] = useState("");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const admin = role === "healjour_admin";

  const load = async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (labId) qs.set("labId", labId);
      const data = await api<{ cases: CaseSummary[] }>(`/api/portal/cases?${qs}`);
      setCases(data.cases); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load cases."); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [labId, reloadKey]);
  // New bookings and lab updates show up without a reload.
  useEffect(() => { const t = setInterval(() => void load(), 30_000); return () => clearInterval(t); }, [labId]);

  const count = (f: Filter) => cases.filter(c => matchesFilter(c, f)).length;
  const cards: Array<{ f: Filter; label: string; icon: typeof Inbox; tone: string }> = [
    { f: "new", label: "New", icon: Inbox, tone: "blue" },
    { f: "progress", label: "In progress", icon: FlaskConical, tone: "amber" },
    { f: "report_ready", label: "Report ready", icon: FileText, tone: "green" },
    { f: "done", label: "Closed", icon: CheckCircle2, tone: "slate" },
    { f: "all", label: "All cases", icon: ClipboardList, tone: "ink" }
  ];
  const q = query.trim().toLowerCase();
  const shown = cases
    .filter(c => matchesFilter(c, filter))
    .filter(c => !q || c.caseNo.toLowerCase().includes(q) || c.patient.name.toLowerCase().includes(q) || c.tests.some(t => t.name.toLowerCase().includes(q) || t.code.toLowerCase().includes(q)));

  return <div className="cases-wrap">
    <div className="case-kpis">
      {cards.map(({ f, label, icon: Icon, tone }) => <button key={f} type="button" className={`case-kpi ${tone} ${filter === f ? "on" : ""}`} onClick={() => setFilter(filter === f ? "open" : f)}>
        <span className="case-kpi-icon"><Icon size={17} /></span>
        <span><b>{count(f)}</b><small>{label}</small></span>
      </button>)}
    </div>

    <div className={`cases-board ${openId || shown.length ? "has-detail" : ""}`}>
      <div className="cases-list">
        <div className="cases-toolbar">
          <div className="cases-title">
            <b>{filter === "open" ? "Open cases" : cards.find(c => c.f === filter)?.label}</b>
            <small>{shown.length} shown{filter !== "open" && <> · <button type="button" className="link-btn" onClick={() => setFilter("open")}>show open</button></>}</small>
          </div>
          <div className="cases-filters">
            {admin && labs && <select value={labId} onChange={e => setLabId(e.target.value)}><option value="">All labs</option>{labs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select>}
            <label className="search-box"><Search size={14} /><input placeholder="Search case, patient or test" value={query} onChange={e => setQuery(e.target.value)} /></label>
            <Button variant="outline" size="sm" onClick={() => void load()} aria-label="Refresh"><RefreshCw size={13} className={loading ? "spin" : ""} /></Button>
          </div>
        </div>
        {error && <p className="delivery-reason">{error}</p>}
        {shown.length === 0 ? <div className="cases-empty"><Inbox size={26} /><b>No cases here</b><p>{admin ? "Send a booking to a lab to start." : "New bookings from Healjour will appear here."}</p></div> :
          <div className="case-rows">
            {shown.map(c => <button type="button" key={c.id} className={`case-row ${openId === c.id ? "is-open" : ""} ${admin && c.unseen ? "is-unseen" : ""}`} onClick={() => setOpenId(c.id)}>
              <span className="case-row-main">
                <span className="case-row-top">
                  <b>{c.patient.name}</b>
                  {c.priority !== "routine" && <span className={`prio ${c.priority}`}>{c.priority}</span>}
                  {admin && c.unseen && <span className="unseen-dot" title="New update from the lab" />}
                </span>
                <small>{c.caseNo} · {shortAge(c)}{admin ? ` · ${c.labName}` : ""}{admin && <> <WorkspaceTag workspace={c.workspace} compact /></>}</small>
                {admin && <CreatedBy label="Sent by" creator={c.creator} />}
                <span className="case-row-tests">{c.tests.slice(0, 3).map(t => <span key={t.code}>{t.code}</span>)}{c.tests.length > 3 && <span>+{c.tests.length - 3}</span>}</span>
              </span>
              <span className="case-row-side">
                <StatusChip status={c.status} />
                <small>{c.reportCount > 0 && <><FileText size={11} /> {c.reportCount} · </>}{fmtDate(c.updatedAt)}</small>
              </span>
            </button>)}
          </div>}
      </div>
      {openId ? <CaseDetail caseId={openId} role={role} onChanged={() => void load()} onClose={() => setOpenId(null)} />
        : shown.length > 0 && <div className="case-placeholder"><ClipboardList size={28} /><b>Select a case</b><p>Its details, status steps, results and reports open here.</p></div>}
    </div>
  </div>;
}
