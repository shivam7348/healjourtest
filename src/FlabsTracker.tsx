import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, Search } from "lucide-react";
import { CreatedBy, WorkspaceTag, type CreatorData, type WorkspaceTagData } from "./lib/record-tags";

type Result = { testName: string; status: string; parameters: Array<{ name: string; value: string }> };
type Booking = {
  id: string; integratorID: string; leadId?: string; account: string; patientName: string; contact: string;
  tests: string[]; status: "unassigned" | "assigned" | "done" | "cancelled"; createdAt?: string; updatedAt: string;
  flabsEvent?: string; flabsEventAt?: string; billId?: string; reportUrl?: string; reportAt?: string; results?: Result[];
  sampleImages?: Array<{ url: string; lat: number | null; lng: number | null; capturedAt?: string }>;
  workspace?: WorkspaceTagData; creator?: CreatorData;
};

const STATUS_TEXT: Record<Booking["status"], string> = { unassigned: "Booked", assigned: "Assigned", done: "Completed", cancelled: "Cancelled" };
const FILTERS: Array<[Booking["status"] | "all", string]> = [["all", "All"], ["unassigned", "Booked"], ["assigned", "Assigned"], ["done", "Completed"], ["cancelled", "Cancelled"]];

const reportState = (b: Booking) => (b.reportUrl ? "Report ready" : b.status === "done" ? "Awaiting report" : "Not yet");
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");

/**
 * Tracks every booking created in Flabs (from the booking form and Flabs webhooks):
 * status, latest Flabs event, report link, and the test parameter values once the report is in.
 */
export default function FlabsTracker({ showResults }: { showResults: boolean }) {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [filter, setFilter] = useState<Booking["status"] | "all">("all");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const res = await fetch("/api/flabs/bookings");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load bookings.");
      const list = (data.appointments as Booking[]).filter(a => a.integratorID);
      setBookings(list.sort((a, b) => (b.createdAt ?? b.updatedAt).localeCompare(a.createdAt ?? a.updatedAt)));
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load bookings."); }
  };
  useEffect(() => { void load(); const t = setInterval(() => void load(), 30000); return () => clearInterval(t); }, []);

  const counts = useMemo(() => ({
    all: bookings.length,
    unassigned: bookings.filter(b => b.status === "unassigned").length,
    assigned: bookings.filter(b => b.status === "assigned").length,
    done: bookings.filter(b => b.status === "done").length,
    cancelled: bookings.filter(b => b.status === "cancelled").length
  }), [bookings]);

  const q = query.trim().toLowerCase();
  const shown = bookings
    .filter(b => filter === "all" || b.status === filter)
    .filter(b => !q || [b.patientName, b.integratorID, b.leadId ?? "", b.contact].some(v => v.toLowerCase().includes(q)));
  const columns = showResults ? 9 : 8;

  return <section className="ftk">
    {error && <div className="access-message error">{error}</div>}
    <div className="ftk-kpis">
      {FILTERS.map(([value, label]) => <button key={value} type="button" className={`ftk-kpi${filter === value ? " on" : ""}`} onClick={() => setFilter(value)}>
        <small>{label}</small><b>{counts[value]}</b>
      </button>)}
    </div>

    <label className="ftk-search"><Search size={14} /><input placeholder="Search by patient, booking ID, lead ID or mobile" value={query} onChange={e => setQuery(e.target.value)} /></label>

    <div className="ftk-table-wrap">
      <table className="ftk-table">
        <thead><tr><th>Booked on</th><th>Patient</th><th>Tests</th><th>Account</th><th>Booking ID</th><th>Status</th><th>Last Flabs update</th>{showResults && <th>Report</th>}<th /></tr></thead>
        <tbody>
          {shown.length === 0 && <tr><td colSpan={columns} className="ftk-empty">No bookings yet. Bookings sent to Flabs from the booking form appear here.</td></tr>}
          {shown.map(b => {
            const isOpen = open === b.id;
            return <TrackerRow key={b.id} b={b} isOpen={isOpen} onToggle={() => setOpen(isOpen ? null : b.id)} showResults={showResults} columns={columns} />;
          })}
        </tbody>
      </table>
    </div>
  </section>;
}

function TrackerRow({ b, isOpen, onToggle, showResults, columns }: { b: Booking; isOpen: boolean; onToggle: () => void; showResults: boolean; columns: number }) {
  return <>
    <tr className={`ftk-row ${b.status}`} onClick={onToggle}>
      <td>{when(b.createdAt)}</td>
      <td><b>{b.patientName || "—"}</b><small>{b.contact}</small><CreatedBy label="Booked by" creator={b.creator} /></td>
      <td>{b.tests.length ? b.tests.join(", ") : "—"}</td>
      <td>{b.account}<div><WorkspaceTag workspace={b.workspace} compact /></div></td>
      <td><code>{b.integratorID}</code></td>
      <td><span className={`ftk-status ${b.status}`}>{STATUS_TEXT[b.status]}</span></td>
      <td>{b.flabsEvent ? <><b>{b.flabsEvent}</b><small>{when(b.flabsEventAt)}</small></> : <span className="muted">—</span>}</td>
      {showResults && <td><span className={`ftk-report ${b.reportUrl ? "ready" : ""}`}>{reportState(b)}</span></td>}
      <td>{isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</td>
    </tr>
    {isOpen && <tr className="ftk-detail-row"><td colSpan={columns}>
      <div className="ftk-detail">
        <div className="ftk-meta">
          <div><small>Flabs lead ID</small><code>{b.leadId ?? "—"}</code></div>
          {showResults && <>
            <div><small>Bill ID</small><code>{b.billId ?? "—"}</code></div>
            <div><small>Report</small>{b.reportUrl ? <a href={b.reportUrl} target="_blank" rel="noopener noreferrer" className="log-link">Open report <ExternalLink size={12} /></a> : <span className="muted">Not received yet</span>}</div>
            <div><small>Report received</small><span>{when(b.reportAt)}</span></div>
          </>}
        </div>
        {b.sampleImages && b.sampleImages.length > 0 && <div className="ftk-samples">
          <b>Sample photos</b>
          {b.sampleImages.map((s, i) => <a key={i} href={s.url} target="_blank" rel="noopener noreferrer" className="log-link">
            Photo {i + 1}{s.lat !== null && s.lng !== null ? ` · ${s.lat}, ${s.lng}` : " · no location"}{s.capturedAt ? ` · ${when(s.capturedAt)}` : ""}
          </a>)}
        </div>}
        {showResults && (b.results && b.results.length > 0 ? <div className="ftk-results">
          <b>Test results</b>
          {b.results.map((r, i) => <div key={i} className="ftk-test">
            <div className="ftk-test-head"><span>{r.testName}</span><span className="ftk-status done">{r.status || "—"}</span></div>
            <table><thead><tr><th>Parameter</th><th>Value</th></tr></thead>
              <tbody>{r.parameters.map((p, j) => <tr key={j}><td>{p.name}</td><td><b>{p.value || "—"}</b></td></tr>)}</tbody>
            </table>
          </div>)}
        </div> : <p className="muted">Results will appear here when Flabs sends the report.</p>)}
      </div>
    </td></tr>}
  </>;
}
