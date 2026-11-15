import { useEffect, useState } from "react";
import { Ban, Calendar, Check, CheckCircle2, Download, Eye, EyeOff, FileUp, Home, MessageSquare, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, fmtDate, STATUS_LABEL, type CaseStatus, type LabCase, type ResultRow, type Role } from "./api";

const MAX_BYTES = 3 * 1024 * 1024;

/** The happy path a case walks through; shown as a progress bar. */
const STEPS: Array<{ status: CaseStatus; label: string }> = [
  { status: "new", label: "New" }, { status: "accepted", label: "Accepted" }, { status: "sample_collected", label: "Sample" },
  { status: "processing", label: "Processing" }, { status: "report_ready", label: "Report" }, { status: "completed", label: "Done" }
];
/** Button words for each move (the chip shows the state; the button says what you do). */
const ACTION: Record<CaseStatus, string> = {
  new: "New", accepted: "Accept case", sample_collected: "Mark sample collected", processing: "Start processing",
  report_ready: "Mark report ready", completed: "Complete case", rejected: "Reject", cancelled: "Cancel case"
};

function Stepper({ status }: { status: CaseStatus }) {
  if (status === "rejected" || status === "cancelled") {
    return <div className="case-stepper stopped"><Ban size={14} /> {STATUS_LABEL[status]}</div>;
  }
  const at = STEPS.findIndex(s => s.status === status);
  return <ol className="case-stepper">
    {STEPS.map((s, i) => <li key={s.status} className={i < at ? "done" : i === at ? "current" : ""}>
      <span className="dot">{i < at ? <Check size={11} /> : i + 1}</span><small>{s.label}</small>
    </li>)}
  </ol>;
}

export const StatusChip = ({ status }: { status: CaseStatus }) => <span className={`case-status ${status}`}>{STATUS_LABEL[status]}</span>;

/**
 * Shows an uploaded report right in the case: images as a picture, PDFs in the browser's PDF viewer.
 * The file is fetched with the user's session and shown from a local blob URL, so it never needs a public link.
 */
function ReportPreview({ url, mimeType, fileName }: { url: string; mimeType: string; fileName: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok) throw new Error("Could not load the report.");
        const blob = new Blob([await res.arrayBuffer()], { type: mimeType });
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) setSrc(objectUrl);
      } catch (e) { if (!cancelled) setError(e instanceof Error ? e.message : "Could not load the report."); }
    })();
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url, mimeType]);

  if (error) return <div className="report-preview"><p className="delivery-reason">{error}</p></div>;
  if (!src) return <div className="report-preview"><p className="delivery-reason">Loading preview…</p></div>;
  return <div className="report-preview">
    {mimeType === "application/pdf"
      ? <iframe src={src} title={`Preview of ${fileName}`} />
      : <a href={src} target="_blank" rel="noreferrer" title="Open full size"><img src={src} alt={`Preview of ${fileName}`} /></a>}
  </div>;
}

/** One case: patient, tests, status actions, results, reports and timeline. Same view for labs and Healjour. */
export function CaseDetail({ caseId, role, onChanged, onClose }: { caseId: string; role: Role; onChanged: () => void; onClose: () => void }) {
  const [c, setC] = useState<LabCase | null>(null);
  const [next, setNext] = useState<Array<{ value: CaseStatus; label: string }>>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [results, setResults] = useState<ResultRow[]>([]);
  const [note, setNote] = useState("");
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [stopping, setStopping] = useState<CaseStatus | null>(null); // reject or cancel waiting for a reason
  const canEdit = role !== "lab_viewer";
  useEffect(() => { if (!notice) return; const t = setTimeout(() => setNotice(""), 4000); return () => clearTimeout(t); }, [notice]);

  const load = async () => {
    try {
      const data = await api<{ case: LabCase; nextStatuses: Array<{ value: CaseStatus; label: string }> }>(`/api/portal/cases/${caseId}`);
      setC(data.case); setNext(data.nextStatuses);
      setPreviewId(prev => prev ?? data.case.reports[data.case.reports.length - 1]?.id ?? null);
      // One result row per test; keep what was entered before.
      setResults(data.case.tests.map(t => data.case.results.find(r => r.testCode === t.code) ?? { testCode: t.code, testName: t.name, value: "", unit: "", referenceRange: "", flag: "" }));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load the case."); }
  };
  useEffect(() => { setC(null); setError(""); setNotice(""); setPreviewId(null); setStopping(null); void load(); }, [caseId]);

  const act = async (task: () => Promise<unknown>, done: string) => {
    setBusy(true); setError(""); setNotice("");
    try { await task(); setNotice(done); setReason(""); setStopping(null); await load(); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : "Something went wrong."); }
    finally { setBusy(false); }
  };

  const moveTo = (status: CaseStatus) => {
    if ((status === "rejected" || status === "cancelled") && !reason.trim()) { setStopping(status); setError(""); return; }
    void act(() => api(`/api/portal/cases/${caseId}/status`, { body: { status, note: reason.trim() || undefined } }), `Moved to ${STATUS_LABEL[status]}.`);
  };

  const upload = (file: File) => {
    if (file.size > MAX_BYTES) { setError("The file is larger than 3 MB."); return; }
    void act(async () => {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      const data = await api<{ report: { id: string } }>(`/api/portal/cases/${caseId}/reports`, { body: { fileName: file.name, mimeType: file.type, dataBase64: btoa(bin) } });
      setPreviewId(data.report.id);
    }, `${file.name} uploaded.`);
  };

  if (error && !c) return <div className="case-detail"><div className="access-message error"><X size={16} />{error}</div></div>;
  if (!c) return <div className="case-detail"><p className="delivery-reason">Loading…</p></div>;
  const closed = ["completed", "rejected", "cancelled"].includes(c.status);

  const forward = next.filter(x => x.value !== "rejected" && x.value !== "cancelled");
  const stops = next.filter(x => x.value === "rejected" || x.value === "cancelled");

  return <div className="case-detail">
    <div className="case-detail-head">
      <div>
        <div className="case-detail-meta">{c.caseNo} · {c.labName}</div>
        <h2>{c.patient.name} <StatusChip status={c.status} /></h2>
        <p>{c.patient.gender} · {c.patient.age} {c.patient.ageUnit}{c.patient.phone ? ` · ${c.patient.phone}` : ""}</p>
      </div>
      <Button variant="outline" size="sm" onClick={onClose} aria-label="Close"><X size={14} /></Button>
    </div>

    <Stepper status={c.status} />

    {notice && <div className="case-toast"><CheckCircle2 size={15} />{notice}</div>}
    {error && <div className="access-message error"><X size={16} />{error}</div>}

    {(forward.length > 0 || stops.length > 0) && <div className="case-actions">
      <div className="case-actions-row">
        {forward.map(x => <Button key={x.value} variant="default" disabled={busy || (x.value === "report_ready" && c.reports.length === 0)} onClick={() => moveTo(x.value)}>
          <Check size={15} /> {ACTION[x.value]}
        </Button>)}
        {stops.map(x => <Button key={x.value} variant="destructive" disabled={busy} onClick={() => { setStopping(stopping === x.value ? null : x.value); setError(""); }}>{ACTION[x.value]}</Button>)}
      </div>
      {forward.some(x => x.value === "report_ready") && c.reports.length === 0 && <small className="muted">Upload the report below to mark it ready.</small>}
      {stopping && <div className="case-stop">
        <input autoFocus value={reason} onChange={e => setReason(e.target.value)} placeholder={stopping === "rejected" ? "Why is the lab rejecting it? e.g. sample haemolysed" : "Why is it cancelled?"} />
        <Button variant="destructive" size="sm" disabled={busy || !reason.trim()} onClick={() => moveTo(stopping)}>Confirm</Button>
        <Button variant="outline" size="sm" onClick={() => { setStopping(null); setReason(""); }}>Back</Button>
      </div>}
    </div>}

    <div className="case-facts">
      <div><span>Priority</span><b><span className={`prio ${c.priority}`}>{c.priority}</span></b></div>
      <div><span>Collection</span><b>{c.collection === "home" ? <><Home size={13} /> Home</> : "Lab visit"}</b></div>
      <div><span>Scheduled</span><b>{c.scheduledAt ? <><Calendar size={13} /> {fmtDate(c.scheduledAt)}</> : "Not set"}</b></div>
      <div><span>Received</span><b>{fmtDate(c.createdAt)}</b></div>
    </div>
    <div className="case-tests">{c.tests.map(t => <span key={t.code} className="case-test">{t.name} <small>{t.code}</small></span>)}</div>
    {c.notes && <div className="case-note-from"><b>Note from Healjour</b>{c.notes}</div>}

    <section className="case-block">
      <h3>Results</h3>
      <div className="access-table-wrap"><table className="access-table builder-table">
        <thead><tr><th>TEST</th><th>VALUE</th><th>UNIT</th><th>REFERENCE</th><th>FLAG</th></tr></thead>
        <tbody>{results.map((r, i) => <tr key={r.testCode}>
          <td><b>{r.testName || r.testCode}</b><br /><code>{r.testCode}</code></td>
          {canEdit && !closed ? <>
            <td><input value={r.value} onChange={e => setResults(results.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} /></td>
            <td><input value={r.unit} onChange={e => setResults(results.map((x, j) => j === i ? { ...x, unit: e.target.value } : x))} /></td>
            <td><input value={r.referenceRange} onChange={e => setResults(results.map((x, j) => j === i ? { ...x, referenceRange: e.target.value } : x))} /></td>
            <td><select value={r.flag} onChange={e => setResults(results.map((x, j) => j === i ? { ...x, flag: e.target.value as ResultRow["flag"] } : x))}>
              <option value="">—</option><option value="normal">Normal</option><option value="low">Low</option><option value="high">High</option><option value="abnormal">Abnormal</option>
            </select></td>
          </> : <><td>{r.value || "—"}</td><td>{r.unit}</td><td>{r.referenceRange}</td><td>{r.flag}</td></>}
        </tr>)}</tbody>
      </table></div>
      {canEdit && !closed && <div className="builder-actions">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void act(() => api(`/api/portal/cases/${caseId}/results`, { method: "PUT", body: { results } }), "Results saved.")}><Save size={13} /> Save results</Button>
      </div>}
    </section>

    <section className="case-block">
      <h3>Reports</h3>
      {c.reports.length === 0 ? <p className="delivery-reason">No report uploaded yet.</p> : <ul className="case-reports">
        {c.reports.map(r => <li key={r.id} className={previewId === r.id ? "is-previewing" : ""}>
          <div className="case-report-row">
            <span><b>{r.fileName}</b><small>{(r.size / 1024).toFixed(0)} KB · {r.uploadedBy} · {fmtDate(r.uploadedAt)}</small></span>
            <span className="case-report-actions">
              <Button variant="outline" size="sm" onClick={() => setPreviewId(previewId === r.id ? null : r.id)}>
                {previewId === r.id ? <><EyeOff size={13} /> Hide</> : <><Eye size={13} /> Preview</>}
              </Button>
              <a className="case-download" href={`/api/portal/cases/${caseId}/reports/${r.id}`}><Download size={13} /> Download</a>
            </span>
          </div>
          {previewId === r.id && <ReportPreview url={`/api/portal/cases/${caseId}/reports/${r.id}`} mimeType={r.mimeType} fileName={r.fileName} />}
        </li>)}
      </ul>}
      {canEdit && !closed && <label className="case-upload">
        <FileUp size={15} /> Upload report (PDF, PNG or JPEG, up to 3 MB)
        <input type="file" accept="application/pdf,image/png,image/jpeg" disabled={busy} onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) upload(file); }} />
      </label>}
    </section>

    <section className="case-block">
      <h3>Timeline</h3>
      <ol className="case-timeline">
        {[...c.timeline].reverse().map((t, i) => <li key={i}>
          <span className="case-timeline-dot" />
          <div><b>{t.action}</b><small>{t.by} · {fmtDate(t.at)}</small>{t.note && <p>{t.note}</p>}</div>
        </li>)}
      </ol>
      {canEdit && <div className="case-note">
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="Add a note for the other side" />
        <Button variant="outline" size="sm" disabled={busy || !note.trim()} onClick={() => void act(async () => { await api(`/api/portal/cases/${caseId}/notes`, { body: { note } }); setNote(""); }, "Note added.")}><MessageSquare size={13} /> Add note</Button>
      </div>}
    </section>
  </div>;
}
