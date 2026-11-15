import { useEffect, useState } from "react";
import { CheckCircle2, Download, FileUp, MessageSquare, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, fmtDate, STATUS_LABEL, type CaseStatus, type LabCase, type ResultRow, type Role } from "./api";

const MAX_BYTES = 3 * 1024 * 1024;

export const StatusChip = ({ status }: { status: CaseStatus }) => <span className={`case-status ${status}`}>{STATUS_LABEL[status]}</span>;

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
  const canEdit = role !== "lab_viewer";

  const load = async () => {
    try {
      const data = await api<{ case: LabCase; nextStatuses: Array<{ value: CaseStatus; label: string }> }>(`/api/portal/cases/${caseId}`);
      setC(data.case); setNext(data.nextStatuses);
      // One result row per test; keep what was entered before.
      setResults(data.case.tests.map(t => data.case.results.find(r => r.testCode === t.code) ?? { testCode: t.code, testName: t.name, value: "", unit: "", referenceRange: "", flag: "" }));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load the case."); }
  };
  useEffect(() => { setC(null); setError(""); setNotice(""); void load(); }, [caseId]);

  const act = async (task: () => Promise<unknown>, done: string) => {
    setBusy(true); setError(""); setNotice("");
    try { await task(); setNotice(done); setReason(""); await load(); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : "Something went wrong."); }
    finally { setBusy(false); }
  };

  const moveTo = (status: CaseStatus) => {
    if ((status === "rejected" || status === "cancelled") && !reason.trim()) { setError("Write the reason first, then press the button again."); return; }
    void act(() => api(`/api/portal/cases/${caseId}/status`, { body: { status, note: reason.trim() || undefined } }), `Moved to ${STATUS_LABEL[status]}.`);
  };

  const upload = (file: File) => {
    if (file.size > MAX_BYTES) { setError("The file is larger than 3 MB."); return; }
    void act(async () => {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      await api(`/api/portal/cases/${caseId}/reports`, { body: { fileName: file.name, mimeType: file.type, dataBase64: btoa(bin) } });
    }, `${file.name} uploaded.`);
  };

  if (error && !c) return <div className="case-detail"><div className="access-message error"><X size={16} />{error}</div></div>;
  if (!c) return <div className="case-detail"><p className="delivery-reason">Loading…</p></div>;
  const closed = ["completed", "rejected", "cancelled"].includes(c.status);

  return <div className="case-detail">
    <div className="case-detail-head">
      <div>
        <div className="eyebrow">{c.labName}</div>
        <h2>{c.caseNo} <StatusChip status={c.status} /></h2>
        <p>{c.patient.name} · {c.patient.gender} · {c.patient.age} {c.patient.ageUnit}{c.patient.phone ? ` · ${c.patient.phone}` : ""}</p>
      </div>
      <Button variant="outline" size="sm" onClick={onClose}><X size={14} /> Close</Button>
    </div>

    <div className="case-facts">
      <div><span>Priority</span><b className={`prio ${c.priority}`}>{c.priority}</b></div>
      <div><span>Collection</span><b>{c.collection === "home" ? "Home collection" : "Lab visit"}</b></div>
      <div><span>Scheduled</span><b>{fmtDate(c.scheduledAt)}</b></div>
      <div><span>Sent</span><b>{fmtDate(c.createdAt)}</b></div>
    </div>
    <div className="case-tests">{c.tests.map(t => <span key={t.code} className="catalog-chip">{t.name} <small>({t.code})</small></span>)}</div>
    {c.notes && <div className="plain-hint"><span><b>Note from Healjour:</b> {c.notes}</span></div>}

    {error && <div className="access-message error"><X size={16} />{error}</div>}
    {notice && <div className="access-message success"><CheckCircle2 size={16} />{notice}</div>}

    {next.length > 0 && <section className="case-block">
      <h3>Update status</h3>
      <div className="builder-actions">
        {next.map(s => <Button key={s.value} variant={s.value === "rejected" || s.value === "cancelled" ? "destructive" : "default"} size="sm" disabled={busy} onClick={() => moveTo(s.value)}>{s.label}</Button>)}
      </div>
      {next.some(s => s.value === "rejected" || s.value === "cancelled") && <label className="field"><span>Reason (needed to reject or cancel)</span><input value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. sample haemolysed, patient not available" /></label>}
      {next.some(s => s.value === "report_ready") && c.reports.length === 0 && <small className="muted">Upload the report below before marking it ready.</small>}
    </section>}

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
        {c.reports.map(r => <li key={r.id}>
          <span><b>{r.fileName}</b><small>{(r.size / 1024).toFixed(0)} KB · {r.uploadedBy} · {fmtDate(r.uploadedAt)}</small></span>
          <a className="case-download" href={`/api/portal/cases/${caseId}/reports/${r.id}`}><Download size={13} /> Download</a>
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
