import { useEffect, useState } from "react";
import { cn } from "cn";
import { KeyRound, Play, RefreshCw, RotateCcw, Shuffle } from "lucide-react";
import { Button } from "@/components/ui/button";

type Stat = {
  id: string; name: string; family: string; description: string; managedBy: "framework" | "legacy";
  versions: string[]; defaultVersion: string; authType: string;
  rateLimit: { requests: number; perMs: number }; retry: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; retryOn: number[] };
  timeoutMs: number; operations: Array<{ id: string; method: string; description: string; versions: string[]; params: string[] }>;
  calls: number; successRate: number | null; avgMs: number; lastCallAt: string | null; openDeadLetters: number;
};
type Attempt = { n: number; at: string; status: number | null; ok: boolean; waitedMs: number; error?: string; durationMs: number };
type CallResult = { callId: string; ok: boolean; status: number | null; data: unknown; attempts: Attempt[]; fromCache: boolean; version: string; sentBody?: unknown; mappingErrors?: string[]; deadLetterId?: string; error?: string };
type CallRecord = { id: string; at: string; connectorId: string; operation: string; version: string; ok: boolean; status: number | null; attempts: number; durationMs: number; fromCache: boolean; idempotencyKey?: string; correlationId: string; error?: string; replayOf?: string };
type DeadLetter = { id: string; at: string; connectorId: string; operation: string; version: string; status: number | null; error: string; attempts: number; idempotencyKey?: string; replays: Array<{ at: string; ok: boolean; status: number | null }>; resolved: boolean };

const FAMILY: Record<string, string> = { his_lis: "HIS / LIS", communication: "Communication", crm: "CRM & marketing", payments: "Payments", app_store: "App Store", other: "Test / other" };
const AUTH: Record<string, string> = { none: "None", api_key: "API key", bearer: "Bearer token", basic: "Basic auth", oauth2_client_credentials: "OAuth 2.0 client credentials" };
const SCENARIO_TEXT: Record<string, string> = {
  ok: "Success: partner accepts at once",
  flaky: "Flaky: fails twice (503), then works: shows retries with backoff",
  ratelimited: "Rate limited: 429 with Retry-After, then works",
  outage: "Outage: down for 30 s: goes to dead letters, replay later",
  bad_request: "Bad data: 400, never retried",
  unauthorized: "Wrong key: 401, never retried"
};
const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const pretty = (v: unknown) => JSON.stringify(v, null, 2);
const newKey = () => `bk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !(data && typeof data === "object" && "attempts" in data)) throw new Error((data as { error?: string }).error || `Request failed (${res.status}).`);
  return data as T;
}

type Tab = "connectors" | "bench" | "calls" | "dead" | "mapping";
type Samples = Record<string, { body?: unknown; params?: Record<string, string> }>;

/** Admin page for the reusable connector framework. */
export default function ConnectorFramework() {
  const [tab, setTab] = useState<Tab>("connectors");
  const [stats, setStats] = useState<Stat[]>([]);
  const [scenarios, setScenarios] = useState<string[]>([]);
  const [sample, setSample] = useState<unknown>({});
  const [samples, setSamples] = useState<Samples>({});
  const [mappings, setMappings] = useState<Record<string, unknown>>({});
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const d = await api<{ connectors: Stat[]; scenarios: string[]; sample: unknown; samples: Samples; mappings: Record<string, unknown> }>("/api/framework/connectors");
      setStats(d.connectors); setScenarios(d.scenarios); setSample(d.sample); setSamples(d.samples); setMappings(d.mappings); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load."); }
  };
  useEffect(() => { void load(); }, []);

  const TABS: Array<[Tab, string]> = [["connectors", "Connectors"], ["bench", "Test bench"], ["calls", "Call log"], ["dead", "Dead letters"], ["mapping", "Mapping playground"]];

  return <div className="content core-page flabs-theme cf-page">
    <div className="page-heading">
      <div><div className="eyebrow">INTEGRATION PLATFORM</div><h1>Connector framework</h1>
        <p>One standard way to call any partner: authentication, rate limits, retries with backoff, idempotency, versions, field mapping, call log and dead-letter replay.</p></div>
      <div className="heading-actions"><Button variant="outline" onClick={() => void load()}><RefreshCw size={15} /> Refresh</Button></div>
    </div>
    {error && <div className="access-message error">{error}</div>}

    <div className="cf-tabs segmented">
      {TABS.map(([v, label]) => <Button key={v} variant="ghost" className={cn("h-auto", tab === v ? "selected" : "")} onClick={() => setTab(v)}>{label}</Button>)}
    </div>

    {tab === "connectors" && <div className="cf-grid">
      {stats.map(s => <section key={s.id} className="cf-card">
        <div className="cf-card-head">
          <div><b>{s.name}</b><small>{FAMILY[s.family] ?? s.family}</small></div>
          <span className={`cf-pill ${s.managedBy}`}>{s.managedBy === "framework" ? "On framework" : "Own client (migration next)"}</span>
        </div>
        <p className="cf-desc">{s.description}</p>
        <dl className="cf-facts">
          <div><dt>Auth</dt><dd><KeyRound size={12} /> {AUTH[s.authType] ?? s.authType}</dd></div>
          <div><dt>Versions</dt><dd>{s.versions.join(", ")} <small>(default {s.defaultVersion})</small></dd></div>
          <div><dt>Rate limit</dt><dd>{s.rateLimit.requests} per {s.rateLimit.perMs / 1000}s</dd></div>
          <div><dt>Retry</dt><dd>{s.retry.maxAttempts} tries · {s.retry.baseDelayMs}–{s.retry.maxDelayMs} ms backoff</dd></div>
          <div><dt>Retries on</dt><dd>{s.retry.retryOn.join(", ")} + network errors</dd></div>
          <div><dt>Timeout</dt><dd>{s.timeoutMs / 1000}s</dd></div>
        </dl>
        <div className="cf-ops">{s.operations.map(o => <span key={o.id}><code>{o.method}</code> {o.id} <small>{o.versions.join("/")}</small></span>)}</div>
        <div className="cf-stats">
          <div><small>Calls</small><b>{s.calls}</b></div>
          <div><small>Success</small><b>{s.successRate === null ? "—" : `${s.successRate}%`}</b></div>
          <div><small>Avg time</small><b>{s.calls ? `${s.avgMs} ms` : "—"}</b></div>
          <div><small>Dead letters</small><b className={s.openDeadLetters ? "warn" : ""}>{s.openDeadLetters}</b></div>
        </div>
      </section>)}
    </div>}

    {tab === "bench" && <TestBench stats={stats.filter(s => s.managedBy === "framework" && s.id !== "app-webhooks")}scenarios={scenarios} samples={samples} onDone={() => void load()} />}
    {tab === "calls" && <CallLog />}
    {tab === "dead" && <DeadLetters onChange={() => void load()} />}
    {tab === "mapping" && <MappingPlayground mappings={mappings} sample={sample} />}
  </div>;
}

function TestBench({ stats, scenarios, samples, onDone }: { stats: Stat[]; scenarios: string[]; samples: Samples; onDone: () => void }) {
  const [connectorId, setConnectorId] = useState("");
  const [operation, setOperation] = useState("");
  const [version, setVersion] = useState("");
  const [scenario, setScenario] = useState("ok");
  const [useKey, setUseKey] = useState(true);
  const [key, setKey] = useState(newKey);
  const [body, setBody] = useState("");
  const [params, setParams] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CallResult | null>(null);
  const [error, setError] = useState("");
  const def = stats.find(s => s.id === connectorId) ?? stats[0];
  const isSandboxPartner = def?.id === "partner-sandbox";

  useEffect(() => {
    if (!def) return;
    setConnectorId(def.id); setOperation(def.operations[0]?.id ?? ""); setVersion(def.defaultVersion);
  }, [def?.id]);
  // Each connector and operation gets a valid sample in that partner's own format.
  useEffect(() => {
    const s = samples[`${connectorId}.${operation}`];
    setBody(s?.body === undefined ? "" : pretty(s.body));
    setParams(s?.params ?? {});
    setResult(null);
  }, [connectorId, operation, samples]);

  const run = async () => {
    setBusy(true); setError(""); setResult(null);
    try {
      const parsed = body.trim() ? JSON.parse(body) : undefined;
      setResult(await api<CallResult>(`/api/framework/connectors/${connectorId}/call`, { operation, version, scenario: isSandboxPartner ? scenario : undefined, body: parsed, params, idempotencyKey: useKey ? key : undefined }));
      onDone();
    } catch (e) { setError(e instanceof SyntaxError ? "The request body is not valid JSON." : e instanceof Error ? e.message : "Run failed."); }
    finally { setBusy(false); }
  };

  if (!def) return <p className="muted">No connector on the framework yet.</p>;
  const op = def.operations.find(o => o.id === operation);
  return <div className="cf-bench">
    <section className="access-card">
      <div className="cf-form">
        <label className="field"><span>Connector</span><select value={connectorId} onChange={e => setConnectorId(e.target.value)}>{stats.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label className="field"><span>Operation</span><select value={operation} onChange={e => setOperation(e.target.value)}>{def.operations.map(o => <option key={o.id} value={o.id}>{o.method} {o.id}</option>)}</select></label>
        <label className="field"><span>API version</span><select value={version} onChange={e => setVersion(e.target.value)}>{(op?.versions ?? def.versions).map(v => <option key={v} value={v}>{v}</option>)}</select></label>
        {isSandboxPartner
          ? <label className="field cf-wide"><span>How the partner behaves</span><select value={scenario} onChange={e => setScenario(e.target.value)}>{scenarios.map(s => <option key={s} value={s}>{SCENARIO_TEXT[s] ?? s}</option>)}</select></label>
          : <p className="cf-note cf-wide">{def.name} answers like the real API (its sandbox, or the live partner when keys are set). To try retries, 429s and outages, pick <b>Partner Sandbox</b>. For the full {def.family === "payments" ? "payment" : def.family === "crm" ? "lead" : "message"} flow use <b>Integration Hub</b>.</p>}
        {(op?.params ?? []).map(name => <label key={name} className="field"><span>Path value: {name}</span><input value={params[name] ?? ""} onChange={e => setParams({ ...params, [name]: e.target.value })} /></label>)}
        <div className="field cf-wide"><span>Idempotency key</span>
          <div className="cf-key">
            <label className="cf-check"><input type="checkbox" checked={useKey} onChange={e => setUseKey(e.target.checked)} /> Send a key</label>
            <input value={key} onChange={e => setKey(e.target.value)} disabled={!useKey} />
            <Button variant="outline" size="sm" onClick={() => setKey(newKey())} disabled={!useKey}><Shuffle size={13} /> New key</Button>
          </div>
          <small>Run twice with the same key: the second run returns the saved result and does not call the partner again.</small>
        </div>
        <label className="field cf-wide"><span>{isSandboxPartner ? "Healjour booking (input; mapped to the partner's v1 or v2 shape)" : `Request body (${def.name} format)`}</span><textarea rows={10} value={body} onChange={e => setBody(e.target.value)} spellCheck={false} placeholder="This operation sends no body" /></label>
      </div>
      <div className="builder-actions"><Button variant="default" onClick={() => void run()} disabled={busy}><Play size={14} /> {busy ? "Running… (retries can take a few seconds)" : "Run call"}</Button></div>
      {error && <div className="access-message error">{error}</div>}
    </section>

    {result && <section className="access-card cf-result">
      <div className="cf-result-head">
        <span className={`cf-status ${result.ok ? "ok" : "bad"}`}>{result.ok ? "Delivered" : "Failed"}{result.status ? ` · HTTP ${result.status}` : ""}</span>
        {result.fromCache && <span className="cf-pill framework">Returned from idempotency store: partner not called</span>}
        {result.deadLetterId && <span className="cf-pill warn">Saved to dead letters: replay it from the Dead letters tab</span>}
        <small>Version {result.version} · call {result.callId}</small>
      </div>
      {result.error && <p className="cf-err">{result.error}</p>}
      {result.mappingErrors?.length ? <ul className="cf-errs">{result.mappingErrors.map(m => <li key={m}>{m}</li>)}</ul> : null}
      {result.attempts.length > 0 && <ol className="cf-attempts">
        {result.attempts.map(a => <li key={a.n} className={a.ok ? "ok" : "bad"}>
          <b>Try {a.n}</b><span>{a.status ?? "no response"}</span><small>{a.waitedMs ? `waited ${a.waitedMs} ms first · ` : ""}{a.durationMs} ms{a.error ? ` · ${a.error}` : ""}</small>
        </li>)}
      </ol>}
      <div className="cf-json2">
        <div><b>Sent to partner (after mapping)</b><pre>{pretty(result.sentBody ?? null)}</pre></div>
        <div><b>Partner response</b><pre>{pretty(result.data)}</pre></div>
      </div>
    </section>}
  </div>;
}

function CallLog() {
  const [calls, setCalls] = useState<CallRecord[]>([]);
  useEffect(() => { void api<{ calls: CallRecord[] }>("/api/framework/calls").then(d => setCalls(d.calls)).catch(() => undefined); }, []);
  return <div className="cf-table-wrap"><table className="cf-table">
    <thead><tr><th>Time</th><th>Connector</th><th>Operation</th><th>Version</th><th>Result</th><th>Tries</th><th>Time taken</th><th>Idempotency key</th><th>Correlation ID</th></tr></thead>
    <tbody>
      {calls.length === 0 && <tr><td colSpan={9} className="cf-empty">No calls yet. Run one from the Test bench.</td></tr>}
      {calls.map(c => <tr key={c.id}>
        <td>{when(c.at)}</td><td>{c.connectorId}</td><td>{c.operation}{c.replayOf ? <small>replay</small> : null}</td><td>{c.version}</td>
        <td><span className={`cf-status ${c.ok ? "ok" : "bad"}`}>{c.fromCache ? "Cached" : c.ok ? "OK" : "Failed"}{c.status ? ` ${c.status}` : ""}</span>{c.error && <small>{c.error}</small>}</td>
        <td>{c.attempts}</td><td>{c.durationMs} ms</td><td><code>{c.idempotencyKey ?? "—"}</code></td><td><code>{c.correlationId}</code></td>
      </tr>)}
    </tbody>
  </table></div>;
}

function DeadLetters({ onChange }: { onChange: () => void }) {
  const [items, setItems] = useState<DeadLetter[]>([]);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const load = () => api<{ deadLetters: DeadLetter[] }>("/api/framework/dead-letters").then(d => setItems(d.deadLetters)).catch(() => undefined);
  useEffect(() => { void load(); }, []);
  const replay = async (id: string) => {
    setBusy(id); setMsg("");
    try {
      const r = await api<{ ok: boolean; result?: CallResult; error?: string }>(`/api/framework/dead-letters/${id}/replay`, {});
      setMsg(r.ok ? "Delivered on replay." : `Still failing: ${r.result?.error ?? r.error ?? "unknown error"}`);
      await load(); onChange();
    } catch (e) { setMsg(e instanceof Error ? e.message : "Replay failed."); }
    finally { setBusy(""); }
  };
  return <>
    <p className="cf-note">Calls that still failed after every retry wait here with their payload and idempotency key. Replay sends the same request again; the key makes sure the partner never creates it twice.</p>
    {msg && <div className="access-message success">{msg}</div>}
    <div className="cf-table-wrap"><table className="cf-table">
      <thead><tr><th>Failed at</th><th>Connector</th><th>Operation</th><th>Error</th><th>Tries</th><th>Replays</th><th>State</th><th /></tr></thead>
      <tbody>
        {items.length === 0 && <tr><td colSpan={8} className="cf-empty">Nothing here. Run the "Outage" scenario on the Test bench to see one.</td></tr>}
        {items.map(d => <tr key={d.id}>
          <td>{when(d.at)}</td><td>{d.connectorId}</td><td>{d.operation} <small>{d.version}</small></td>
          <td>{d.error}{d.idempotencyKey && <small>key {d.idempotencyKey}</small>}</td><td>{d.attempts}</td>
          <td>{d.replays.length ? d.replays.map((r, i) => <small key={i}>{when(r.at)} · {r.ok ? "OK" : `failed ${r.status ?? ""}`}</small>) : "—"}</td>
          <td><span className={`cf-status ${d.resolved ? "ok" : "bad"}`}>{d.resolved ? "Delivered" : "Waiting"}</span></td>
          <td>{!d.resolved && <Button variant="outline" size="sm" disabled={busy === d.id} onClick={() => void replay(d.id)}><RotateCcw size={13} /> {busy === d.id ? "Replaying…" : "Replay"}</Button>}</td>
        </tr>)}
      </tbody>
    </table></div>
  </>;
}

function MappingPlayground({ mappings, sample }: { mappings: Record<string, unknown>; sample: unknown }) {
  const [which, setWhich] = useState("v2");
  const [spec, setSpec] = useState("");
  const [input, setInput] = useState("");
  const [out, setOut] = useState<{ output: unknown; errors: string[]; warnings: string[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { if (mappings[which]) setSpec(pretty(mappings[which])); }, [which, mappings]);
  useEffect(() => { setInput(pretty(sample)); }, [sample]);
  const run = async () => {
    setError(""); setOut(null);
    try { setOut(await api("/api/framework/map", { spec: JSON.parse(spec), input: JSON.parse(input) })); }
    catch (e) { setError(e instanceof SyntaxError ? "Spec or input is not valid JSON." : e instanceof Error ? e.message : "Mapping failed."); }
  };
  return <section className="access-card">
    <p className="cf-note">Each rule reads <code>from</code>, cleans it with <code>transform</code> (trim, upper, lower, number, boolean, phone10, isoDate, gender, split, join, prefix:…, map:{"{…}"}) and writes <code>to</code>. Rules can be <code>required</code>, have a <code>default</code>, or a <code>const</code>.</p>
    <div className="cf-form">
      <label className="field"><span>Start from</span><select value={which} onChange={e => setWhich(e.target.value)}>{Object.keys(mappings).map(k => <option key={k} value={k}>Sandbox order {k}</option>)}</select></label>
    </div>
    <div className="cf-json2">
      <label className="field"><span>Mapping spec</span><textarea rows={16} value={spec} onChange={e => setSpec(e.target.value)} spellCheck={false} /></label>
      <label className="field"><span>Input record</span><textarea rows={16} value={input} onChange={e => setInput(e.target.value)} spellCheck={false} /></label>
    </div>
    <div className="builder-actions"><Button variant="default" onClick={() => void run()}><Play size={14} /> Run mapping</Button></div>
    {error && <div className="access-message error">{error}</div>}
    {out && <div className="cf-json2">
      <div><b>Output</b><pre>{pretty(out.output)}</pre></div>
      <div><b>Problems</b>{out.errors.length + out.warnings.length === 0 ? <p className="muted">None</p> : <ul className="cf-errs">{out.errors.map(e => <li key={e}>{e}</li>)}{out.warnings.map(w => <li key={w} className="warn">{w}</li>)}</ul>}</div>
    </div>}
  </section>;
}
