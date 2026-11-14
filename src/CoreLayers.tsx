import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { CheckCircle2, Play, RefreshCw, X, AlertTriangle, ListChecks, Shuffle } from "lucide-react";

type LayerId = "connector_mesh" | "normalization" | "identity_consent" | "orchestration";
type TraceStatus = "passed" | "passed_with_warnings" | "failed";
type LayerIssue = { layer: LayerId; code: string; severity: "info" | "warning" | "error"; message: string };
type LayerTrace = { layer: LayerId; title: string; status: TraceStatus; summary: string; issues: LayerIssue[] };

type Sample = { id: string; label: string; connectorId: string; payload: string };
type Delivery = { deliveryId: string; sinkLabel: string; status: "delivered" | "dead_letter" | "skipped"; reason?: string; totalLatencyMs: number };
type PipelineResult = { status: string; layers: LayerTrace[]; deliveries: Delivery[] };

type BatchRow = {
  n: number; label: string; tests: string; status: string; stoppedAt: string;
  delivered: number; failed: number; skipped: number; ms: number; error?: string;
};

const LAYER_LABELS: Record<LayerId, string> = {
  connector_mesh: "01 · Read the source",
  normalization: "02 · Clean and map",
  identity_consent: "03 · Match patient & consent",
  orchestration: "04 · Send to destinations"
};
const LAYER_ORDER: LayerId[] = ["connector_mesh", "normalization", "identity_consent", "orchestration"];
const ALL_SINKS = ["healjour_record", "insurer_underwriting", "insurer_claims", "health_aggregator", "corporate_wellness"];

// Healjour test codes the mock generator picks from. "ZZTEST" is deliberately unknown,
// so some runs show the quarantine path working.
const MOCK_TESTS: Array<{ code: string; name: string; unit: string; range: string; value: () => string }> = [
  { code: "CBC", name: "Complete Blood Count", unit: "10^3/uL", range: "4.0-11.0", value: () => (4 + Math.random() * 8).toFixed(1) },
  { code: "GLU", name: "Fasting glucose", unit: "mg/dL", range: "70-100", value: () => String(Math.round(70 + Math.random() * 90)) },
  { code: "TSH", name: "Thyroid stimulating hormone", unit: "mIU/L", range: "0.4-4.0", value: () => (0.3 + Math.random() * 5).toFixed(2) },
  { code: "HBA1C", name: "HbA1c", unit: "%", range: "4.0-5.6", value: () => (4.5 + Math.random() * 4).toFixed(1) },
  { code: "CREA", name: "Creatinine", unit: "mg/dL", range: "0.6-1.3", value: () => (0.5 + Math.random() * 1.2).toFixed(2) },
  { code: "CHOL", name: "Total cholesterol", unit: "mg/dL", range: "<200", value: () => String(Math.round(140 + Math.random() * 120)) },
  { code: "ZZTEST", name: "Unknown panel", unit: "mg/dL", range: "-", value: () => "12" }
];

const MOCK_PATIENTS = [
  { mrn: "MOCK-001", family: "Sharma", given: "Anil", dob: "19790412", sex: "M" },
  { mrn: "MOCK-002", family: "Iyer", given: "Meera", dob: "19911130", sex: "F" },
  { mrn: "MOCK-003", family: "Verma", given: "Rahul", dob: "19880903", sex: "M" },
  { mrn: "MOCK-004", family: "Khan", given: "Sana", dob: "19950215", sex: "F" },
  { mrn: "MOCK-005", family: "Das", given: "Arjun", dob: "19701022", sex: "M" },
  { mrn: "MOCK-006", family: "Nair", given: "Lakshmi", dob: "19860618", sex: "F" },
  { mrn: "MOCK-007", family: "Gupta", given: "Vikram", dob: "19600305", sex: "M" },
  { mrn: "MOCK-008", family: "Reddy", given: "Kavya", dob: "20010727", sex: "F" },
  { mrn: "MOCK-009", family: "Singh", given: "Harpreet", dob: "19831111", sex: "M" },
  { mrn: "MOCK-010", family: "Joshi", given: "Neha", dob: "19920409", sex: "F" }
];

const pick = <T,>(items: T[]) => items[Math.floor(Math.random() * items.length)];

/** One HL7 v2 ORU^R01 result message for a mock patient, with one or two tests. */
function mockHl7(n: number): { payload: string; tests: string; patient: string } {
  const patient = MOCK_PATIENTS[n % MOCK_PATIENTS.length];
  const count = Math.random() < 0.4 ? 2 : 1;
  const chosen = Array.from(new Set(Array.from({ length: count }, () => pick(MOCK_TESTS))));
  const ts = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const phone = `9${String(100000000 + Math.floor(Math.random() * 899999999))}`;
  const lines = [
    `MSH|^~\\&|LIS|CITY|HEALJOUR|HJ|${ts}||ORU^R01|MOCK-${String(n).padStart(4, "0")}|P|2.5`,
    `PID|1||${patient.mrn}^^^CITY^MR||${patient.family}^${patient.given}||${patient.dob}|${patient.sex}|||||${phone}`,
    `OBR|1|ORD-${String(n).padStart(4, "0")}|ACC-${String(n).padStart(4, "0")}|${chosen[0].code}^${chosen[0].name}|R||${ts}`
  ];
  chosen.forEach((t, i) => {
    lines.push(`OBX|${i + 1}|NM|${t.code}^${t.name}||${t.value()}|${t.unit}|${t.range}|N|||F`);
  });
  return { payload: lines.join("\n"), tests: chosen.map(t => t.code).join(", "), patient: `${patient.given} ${patient.family}` };
}

const statusText = (status: TraceStatus) => (status === "passed" ? "Pass" : status === "passed_with_warnings" ? "Pass with warnings" : "Stopped");
const chipClass = (status: TraceStatus) => `core-layer-chip ${status}`;

export default function CoreLayers() {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [sampleId, setSampleId] = useState("");
  const [payload, setPayload] = useState("");
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [batchCount, setBatchCount] = useState(10);
  const [batch, setBatch] = useState<BatchRow[] | null>(null);
  const [batchProgress, setBatchProgress] = useState("");

  const loadSample = async (id: string) => {
    try {
      const res = await fetch(`/api/core/samples/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Sample not available.");
      setSampleId(id);
      setPayload(data.payload);
      setResult(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load sample.");
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/core/topology");
        const data = await res.json();
        if (!res.ok) throw new Error("Core API not reachable.");
        setSamples(data.samples);
        if (data.samples[0]) await loadSample(data.samples[0].id);
      } catch {
        setError("Backend is not running. Start it with `npm run dev`.");
      }
    })();
    // loadSample is stable for this page; it only needs to run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Sends one payload through the four layers. Only Healjour's internal sinks are used. */
  const runPayload = async (connectorId: string, body: string) => {
    const res = await fetch("/api/core/pipeline/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectorId, payload: body, sinks: ALL_SINKS, failureMode: "none" })
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data.issues ?? [data.error]).join(" ") || "Run failed.");
    return data as PipelineResult;
  };

  const run = async () => {
    const sample = samples.find(s => s.id === sampleId);
    if (!sample) return;
    setBusy(true);
    setError("");
    try {
      setResult(await runPayload(sample.connectorId, payload));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Run failed.");
    } finally {
      setBusy(false);
    }
  };

  const summarise = (n: number, label: string, tests: string, data: PipelineResult, ms: number): BatchRow => {
    const stopped = data.layers.find(l => l.status === "failed");
    const count = (s: Delivery["status"]) => data.deliveries.filter(d => d.status === s).length;
    return {
      n, label, tests, ms,
      status: data.status,
      stoppedAt: stopped ? LAYER_LABELS[stopped.layer] : "—",
      delivered: count("delivered"), failed: count("dead_letter"), skipped: count("skipped")
    };
  };

  /** Runs every built-in sample, one after another, and tabulates the results. */
  const runAllSamples = async () => {
    setBusy(true); setError(""); setBatch([]);
    const rows: BatchRow[] = [];
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      setBatchProgress(`Running ${i + 1} of ${samples.length}: ${s.label}`);
      const started = performance.now();
      try {
        const data = await runPayload(s.connectorId, s.payload);
        rows.push(summarise(i + 1, s.label, "fixture", data, Math.round(performance.now() - started)));
      } catch (e) {
        rows.push({ n: i + 1, label: s.label, tests: "fixture", status: "error", stoppedAt: "—", delivered: 0, failed: 0, skipped: 0, ms: 0, error: e instanceof Error ? e.message : "Failed" });
      }
      setBatch([...rows]);
    }
    setBatchProgress("");
    setBusy(false);
  };

  /** Generates N mock HL7 orders with random tests and patients, and runs each one. */
  const runMockBatch = async () => {
    setBusy(true); setError(""); setBatch([]);
    const rows: BatchRow[] = [];
    for (let i = 1; i <= batchCount; i++) {
      const mock = mockHl7(i);
      setBatchProgress(`Running ${i} of ${batchCount}: ${mock.patient}`);
      const started = performance.now();
      try {
        const data = await runPayload("lis-hl7v2-oru", mock.payload);
        rows.push(summarise(i, mock.patient, mock.tests, data, Math.round(performance.now() - started)));
      } catch (e) {
        rows.push({ n: i, label: mock.patient, tests: mock.tests, status: "error", stoppedAt: "—", delivered: 0, failed: 0, skipped: 0, ms: 0, error: e instanceof Error ? e.message : "Failed" });
      }
      setBatch([...rows]);
    }
    setBatchProgress("");
    setBusy(false);
  };

  const completed = batch?.filter(r => r.status === "completed" || r.status === "completed_with_issues").length ?? 0;
  const stopped = batch?.filter(r => r.status === "stopped" || r.status === "error").length ?? 0;
  const avgMs = batch && batch.length ? Math.round(batch.reduce((s, r) => s + r.ms, 0) / batch.length) : 0;

  return <div className="content core-page">
    <div className="page-heading">
      <div>
        <div className="eyebrow">HEALJOUR CORE</div>
        <h1>Process lab data in one place</h1>
        <p>Choose a sample, then press Run. The result for each step will appear below.</p>
      </div>
    </div>

    <section className="access-card">
      <div className="access-card-head">
        <div><h2>1. Choose a sample</h2><p>This is data that came from a lab (fake/test data).</p></div>
      </div>
      <div className="core-controls">
        <label className="field">
          <span>Sample</span>
          <select value={sampleId} onChange={e => void loadSample(e.target.value)} disabled={busy}>
            {samples.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <div className="field">
          <span>&nbsp;</span>
          <Button variant="default" onClick={() => void run()} disabled={busy || !payload}>
            {busy ? <RefreshCw className="spin" size={15} /> : <Play size={15} />} {busy ? "Running…" : "2. Run"}
          </Button>
        </div>
      </div>
    </section>

    <section className="access-card">
      <div className="access-card-head">
        <div><h2>Batch testing with mock data</h2><p>Run many tests at once. Every run goes through all four steps, and the table shows what happened to each one.</p></div>
      </div>
      <div className="batch-controls">
        <Button variant="outline" onClick={() => void runAllSamples()} disabled={busy || samples.length === 0}><ListChecks size={15} /> Run all {samples.length} samples</Button>
        <label className="batch-count">
          <span>Mock orders</span>
          <input type="number" min={1} max={200} value={batchCount} disabled={busy} onChange={e => setBatchCount(Math.max(1, Math.min(200, Number(e.target.value) || 1)))} />
        </label>
        <Button variant="default" onClick={() => void runMockBatch()} disabled={busy}><Shuffle size={15} /> Generate and run {batchCount} mock orders</Button>
      </div>
      {busy && batchProgress && <p className="delivery-reason">{batchProgress}</p>}

      {batch && batch.length > 0 && <>
        <div className="platform-stats batch-stats">
          <div className="platform-stat"><small>Runs</small><b>{batch.length}</b><span>{busy ? "Still running" : "Finished"}</span></div>
          <div className="platform-stat"><small>Completed</small><b>{completed}</b><span>Went through all steps</span></div>
          <div className="platform-stat"><small>Stopped</small><b>{stopped}</b><span>Stopped at a step</span></div>
          <div className="platform-stat"><small>Average time</small><b>{avgMs} ms</b><span>Per run</span></div>
        </div>
        <div className="access-table-wrap"><table className="access-table">
          <thead><tr><th>#</th><th>PATIENT / SAMPLE</th><th>TESTS</th><th>RESULT</th><th>STOPPED AT</th><th>SENT</th><th>FAILED</th><th>TIME</th></tr></thead>
          <tbody>{batch.map(r => <tr key={r.n}>
            <td>{r.n}</td>
            <td>{r.label}</td>
            <td><code>{r.tests}</code></td>
            <td>{r.error
              ? <span className="core-layer-chip failed">Error</span>
              : <span className={`core-layer-chip ${r.status === "stopped" ? "failed" : r.status === "completed_with_issues" ? "passed_with_warnings" : "passed"}`}>{r.status === "stopped" ? "Stopped" : r.status === "completed_with_issues" ? "Has issues" : "Completed"}</span>}
            </td>
            <td>{r.stoppedAt}</td>
            <td>{r.delivered}</td>
            <td>{r.failed}</td>
            <td>{r.ms} ms</td>
          </tr>)}</tbody>
        </table></div>
      </>}
    </section>

    {error && <div className="access-message error"><X size={16} />{error}<Button className="h-auto" variant="ghost" onClick={() => setError("")}>Dismiss</Button></div>}

    {result && <>
      <section className="access-card">
        <div className="access-card-head">
          <div><h2>3. Result</h2><p>Status of each step.</p></div>
          <span className={`access-status ${result.status === "completed" ? "approved" : result.status === "stopped" ? "rejected" : "pending"}`}>
            {result.status === "completed" ? "Complete" : result.status === "stopped" ? "Stopped" : "Has issues"}
          </span>
        </div>

        <div className="simple-steps">
          {LAYER_ORDER.map(id => {
            const layer = result.layers.find(l => l.layer === id);
            if (!layer) return <div key={id} className="trace-card pending simple-step">
              <div className="trace-title"><b>{LAYER_LABELS[id]}</b><small>Stopped at an earlier step, so this step did not run.</small></div>
              <span className="core-layer-chip skipped">NOT RUN</span>
            </div>;
            const topIssues = layer.issues.filter(i => i.severity !== "info").slice(0, 3);
            return <div key={id} className={`trace-card ${layer.status} simple-step`}>
              <div className="trace-title"><b>{LAYER_LABELS[id]}</b><small>{layer.summary}</small></div>
              <span className={chipClass(layer.status)}>{statusText(layer.status)}</span>
              {topIssues.length > 0 && <ul className="issue-list simple-issues">
                {topIssues.map((issue, i) => <li key={`${issue.code}-${i}`} className={issue.severity}>
                  {issue.severity === "error" ? <X size={14} /> : <AlertTriangle size={14} />}
                  <span>{issue.message}</span>
                </li>)}
              </ul>}
            </div>;
          })}
        </div>
      </section>

      {result.deliveries.length > 0 && <section className="access-card">
        <div className="access-card-head">
          <div><h2>Where it was sent</h2><p>Result for each destination.</p></div>
        </div>
        <div className="delivery-list">
          {result.deliveries.map(d => <div key={d.deliveryId} className={`delivery ${d.status}`}>
            <div className="delivery-head">
              <b>{d.sinkLabel}</b>
              <span className={`core-layer-chip ${d.status === "delivered" ? "passed" : d.status === "skipped" ? "skipped" : "failed"}`}>
                {d.status === "delivered" ? <><CheckCircle2 size={12} /> Sent</> : d.status === "skipped" ? "Skip" : "Fail"}
              </span>
            </div>
            {d.reason && <p className="delivery-reason">{d.reason}</p>}
          </div>)}
        </div>
      </section>}
    </>}

    <div className="access-bottom-note">Demo: data is only processed on this server. No real lab or insurer is contacted.</div>
  </div>;
}
