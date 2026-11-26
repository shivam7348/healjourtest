import { Button } from "@/components/ui/button";
import { useCallback, useEffect, useState } from "react";
import { Building2, Plug, RefreshCw, Layers } from "lucide-react";
import { api } from "./portal/api";

type Conn = {
  id: string; label: string; clientIdMasked: string; branchId: string | null; phase: string;
  party: { field: string; id: string } | null; isDefault: boolean; secretStorage: string; mappedTests: number;
};
type Log = { id: string; at: string; status: string; type: string; account: string; title: string };
type Catalog = { tests: Array<{ code: string; active: boolean }>; packages: Array<{ code: string; active: boolean }> };
type Topology = { connectors: Array<{ id: string; label: string; format: string; transports: string[]; direction: string; description: string }> };

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

type OverviewAccess = { showConnections: boolean; showCatalog: boolean; showLogs: boolean };

function useLive({ showConnections = false, showCatalog = false, showLogs = false, showTopology = false }: Partial<OverviewAccess> & { showTopology?: boolean }) {
  const [connections, setConnections] = useState<Conn[]>([]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [logs, setLogs] = useState<Log[]>([]);
  const [topology, setTopology] = useState<Topology | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [c, cat, l, t] = await Promise.all([
        showConnections ? api<{ connections: Conn[] }>("/api/flabs/connections") : null,
        showCatalog ? api<Catalog>("/api/catalog") : null,
        showLogs ? api<{ logs: Log[] }>("/api/logs?limit=300") : null,
        showTopology ? api<Topology>("/api/core/topology") : null
      ]);
      setConnections(c?.connections ?? []);
      setCatalog(cat);
      setLogs(l?.logs ?? []);
      setTopology(t);
    } catch {
      setError("Backend se data nahi aaya. Check karo ki server chal raha hai.");
    } finally {
      setLoading(false);
    }
  }, [showConnections, showCatalog, showLogs, showTopology]);
  useEffect(() => {
    if (showConnections || showCatalog || showLogs || showTopology) void load();
  }, [load, showConnections, showCatalog, showLogs, showTopology]);
  return { connections, catalog, logs, topology, loading, error, reload: load };
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return <div className="platform-stat"><small>{label}</small><b>{value}</b><span>{hint}</span></div>;
}

function Header({ eyebrow, title, description, onReload, loading }: { eyebrow: string; title: string; description: string; onReload?: () => void; loading: boolean }) {
  return <div className="page-heading">
    <div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>
    {onReload && <div className="heading-actions"><Button variant="outline" onClick={onReload} disabled={loading}><RefreshCw size={15} className={loading ? "spin" : ""} /> Refresh</Button></div>}
  </div>;
}

export function OverviewPage({ showConnections, showCatalog, showLogs }: OverviewAccess) {
  const d = useLive({ showConnections, showCatalog, showLogs });
  const showStats = showConnections || showCatalog || showLogs;
  const today = new Date().toDateString();
  const todays = d.logs.filter(l => new Date(l.at).toDateString() === today);
  const bookingsToday = todays.filter(l => l.type === "booking" && (l.status === "success" || l.status === "duplicate")).length;
  const failedToday = todays.filter(l => l.status === "error").length;
  const activeTests = d.catalog?.tests.filter(t => t.active).length ?? 0;
  const activePackages = d.catalog?.packages.filter(p => p.active).length ?? 0;

  return <div className="content core-page flabs-theme">
    <Header eyebrow="HEALJOUR INTEGRATION HUB" title="Overview" description={showStats ? "Today's activity and the state of your integrations." : "Use the sidebar to open the pages available to your role."} onReload={showStats ? d.reload : undefined} loading={d.loading} />
    {d.error && <div className="access-message error">{d.error}</div>}
    {showStats && <div className="platform-stats">
      {showConnections && <Stat label="Flabs accounts" value={d.connections.length} hint={`${d.connections.filter(c => c.isDefault).length} default`} />}
      {showLogs && <>
        <Stat label="Bookings today" value={bookingsToday} hint="Sent to Flabs or already existed" />
        <Stat label="Failed today" value={failedToday} hint="Need attention in Transactions & Logs" />
      </>}
      {showCatalog && <Stat label="Catalog" value={`${activeTests} tests`} hint={`${activePackages} packages`} />}
    </div>}
    {showLogs && <section className="access-card">
      <div className="access-card-head"><div><h2>Recent activity</h2><p>Latest entries from Transactions & Logs.</p></div></div>
      {d.logs.length === 0 ? <div className="empty-state"><b>No activity yet</b><p>Bookings, syncs and account changes appear here.</p></div> :
        <div className="platform-list">{d.logs.slice(0, 6).map(l => <div key={l.id} className="platform-row">
          <span className={`core-layer-chip ${l.status === "success" ? "passed" : l.status === "error" ? "failed" : "skipped"}`}>{l.status === "success" ? "Done" : l.status === "duplicate" ? "Already existed" : l.status === "error" ? "Failed" : "Info"}</span>
          <b>{l.title}</b><small>{l.account}</small><span className="muted">{when(l.at)}</span>
        </div>)}</div>}
    </section>}
  </div>;
}

export function OrganizationsPage() {
  const d = useLive({ showConnections: true });
  const parties = d.connections.filter(c => c.party);
  const labs = d.connections.filter(c => !c.party);

  return <div className="content core-page flabs-theme">
    <Header eyebrow="HEALJOUR INTEGRATION HUB" title="Organizations" description="Labs, corporate accounts and referring doctors or hospitals that send or receive bookings." onReload={d.reload} loading={d.loading} />
    {d.error && <div className="access-message error">{d.error}</div>}
    <div className="platform-stats">
      <Stat label="Labs" value={labs.length} hint="General lab accounts" />
      <Stat label="Corporate and referral" value={parties.length} hint="Accounts scoped to a party" />
      <Stat label="Total accounts" value={d.connections.length} hint="Connected in Flabs CRM" />
    </div>
    <section className="access-card">
      <div className="access-card-head"><div><h2>Accounts</h2><p>Each row is one Flabs account. Manage them in Test Catalog.</p></div></div>
      {d.connections.length === 0 ? <div className="empty-state"><Building2 size={24} /><b>No organization connected yet</b><p>Add a Flabs account in Test Catalog → Flabs CRM accounts.</p></div> :
        <div className="access-table-wrap"><table className="access-table">
          <thead><tr><th>NAME</th><th>TYPE</th><th>PARTY ID</th><th>BRANCH</th><th>PHASE</th><th>MAPPED TESTS</th></tr></thead>
          <tbody>{d.connections.map(c => <tr key={c.id}>
            <td><b>{c.label}</b>{c.isDefault && <span className="core-layer-chip passed" style={{ marginLeft: 8 }}>default</span>}<small>{c.clientIdMasked}</small></td>
            <td>{c.party ? (c.party.field === "corporateUser" ? "Corporate" : "Referral") : "Lab"}</td>
            <td>{c.party ? <code>{c.party.id}</code> : <span className="muted">—</span>}</td>
            <td><code>{c.branchId ?? "—"}</code></td>
            <td>{c.phase}</td>
            <td>{c.mappedTests}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
  </div>;
}

export function IntegrationsPage() {
  const d = useLive({ showConnections: true, showTopology: true });
  const flabsOk = d.connections.length > 0;
  const mapped = d.connections.reduce((s, c) => s + c.mappedTests, 0);

  return <div className="content core-page flabs-theme">
    <Header eyebrow="HEALJOUR INTEGRATION HUB" title="Integrations" description="Every connector Healjour can run, and whether it is set up." onReload={d.reload} loading={d.loading} />
    {d.error && <div className="access-message error">{d.error}</div>}
    <section className="access-card">
      <div className="access-card-head"><div><h2>Connectors</h2><p>Healjour Core connectors for lab sources, and external systems.</p></div></div>
      <div className="platform-list">
        <div className="platform-row integration-row">
          <span className="platform-icon"><Plug size={16} /></span>
          <div><b>Flabs CRM</b><small>Lab bookings and leads. {d.connections.length} account(s), {mapped} mapped test(s).</small></div>
          <span className={`core-layer-chip ${flabsOk ? "passed" : "skipped"}`}>{flabsOk ? "Connected" : "Not connected"}</span>
        </div>
        {(d.topology?.connectors ?? []).map(c => <div key={c.id} className="platform-row integration-row">
          <span className="platform-icon"><Layers size={16} /></span>
          <div><b>{c.label}</b><small>{c.description} · {c.format.toUpperCase()} · {c.transports.join(", ")} · {c.direction}</small></div>
          <span className="core-layer-chip passed">Available</span>
        </div>)}
      </div>
    </section>
    <StudioIntegrations />
  </div>;
}

type StudioIntegration = {
  id: string; name: string; labCode: string; transport: string; delimiter: string; pollingMinutes: number;
  direction: "both" | "outbound" | "inbound"; outboundPath?: string; inboundPath?: string;
  status: "draft" | "tested"; lastTest?: { passed: boolean; message: string; at: string }; updatedAt: string;
};

const DIRECTION_TEXT = { both: "Sends & receives", outbound: "Sends orders only", inbound: "Receives results only" } as const;
const TRANSPORT_TEXT: Record<string, string> = { sftp: "SFTP", managed_gateway: "Managed gateway", local_folder: "Local folder" };

/** CSV lab connections saved from the Integration Studio wizard. */
function StudioIntegrations() {
  const [items, setItems] = useState<StudioIntegration[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState("");

  const load = async () => {
    try {
      const res = await fetch("/api/integrations");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load integrations.");
      setItems(data.integrations);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load integrations.");
    }
  };
  useEffect(() => { void load(); }, []);

  const act = async (id: string, path: string, method: "POST" | "DELETE") => {
    setBusy(id); setError("");
    try {
      const res = await fetch(path, { method });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy("");
    }
  };

  return <section className="access-card">
    <div className="access-card-head">
      <div><h2>Lab integrations ({items.length})</h2><p>CSV connections saved from Integration Studio. All are drafts: nothing connects to a real lab.</p></div>
      <Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw size={14} /> Refresh</Button>
    </div>
    {error && <div className="access-message error">{error}</div>}
    {items.length === 0 ? <p className="delivery-reason">None yet. Open Integration Studio, fill the steps and press Save draft.</p> :
      <div className="access-table-wrap"><table className="access-table">
        <thead><tr><th>INTEGRATION</th><th>DIRECTION</th><th>TRANSPORT</th><th>CHECKS</th><th>STATUS</th><th></th></tr></thead>
        <tbody>{items.map(i => <tr key={i.id}>
          <td><b>{i.name}</b><small>{i.labCode}</small></td>
          <td>{DIRECTION_TEXT[i.direction]}<small>{[i.outboundPath, i.inboundPath].filter(Boolean).join(" · ")}</small></td>
          <td>{TRANSPORT_TEXT[i.transport] ?? i.transport}<small>Every {i.pollingMinutes} min · delimiter {i.delimiter === "\t" ? "Tab" : i.delimiter}</small></td>
          <td>{i.lastTest ? <span className={`core-layer-chip ${i.lastTest.passed ? "passed" : "stopped"}`}>{i.lastTest.passed ? "Passed" : "Failed"}</span> : <span className="muted">Not run</span>}</td>
          <td><span className={`core-layer-chip ${i.status === "tested" ? "passed" : "skipped"}`}>{i.status === "tested" ? "Tested draft" : "Draft"}</span></td>
          <td><div className="access-row-actions">
            <Button variant={openId === i.id ? "default" : "outline"} size="sm" onClick={() => setOpenId(openId === i.id ? "" : i.id)}>{openId === i.id ? "Close" : "Run"}</Button>
            <Button variant="outline" size="sm" disabled={busy === i.id} onClick={() => void act(i.id, `/api/integrations/${i.id}/test`, "POST")}>Run checks</Button>
            <Button variant="ghost" size="sm" disabled={busy === i.id} onClick={() => { if (window.confirm(`Remove ${i.name}?`)) void act(i.id, `/api/integrations/${i.id}`, "DELETE"); }}>Remove</Button>
          </div></td>
        </tr>)}</tbody>
      </table></div>}
    {(() => {
      const open = items.find(i => i.id === openId);
      return open ? <IntegrationRunPanel key={open.id} integration={open} /> : null;
    })()}
  </section>;
}

type FileInfo = { name: string; rows: number; bytes: number };
type Folders = { root: string; folders: Record<"outbound" | "pickedUp" | "inbound" | "processed" | "rejected", FileInfo[]>; paths: Record<string, string | null> };
type Outcome = { file: string; status: string; rows: number; reason?: string; runId?: string; delivered?: number; quarantined?: number; issues?: string[] };

const OUTCOME_TEXT: Record<string, string> = {
  imported: "Imported", imported_with_issues: "Imported with warnings", rejected: "Rejected", duplicate: "Duplicate, skipped"
};

/** Runs one integration in the sandbox: send orders, let the simulated lab answer, receive the results. */
function IntegrationRunPanel({ integration }: { integration: StudioIntegration }) {
  const [files, setFiles] = useState<Folders | null>(null);
  const [count, setCount] = useState("5");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const sends = integration.direction !== "inbound";
  const receives = integration.direction !== "outbound";

  const loadFiles = async () => {
    const res = await fetch(`/api/integrations/${integration.id}/files`);
    if (res.ok) setFiles(await res.json());
  };
  useEffect(() => { void loadFiles(); }, [integration.id]);

  const step = async (name: string, path: string, body?: unknown, done?: (data: any) => string) => {
    setBusy(name); setError(""); setMessage("");
    try {
      const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Step failed.");
      setMessage(done ? done(data) : "Done.");
      if (data.outcomes) setOutcomes(data.outcomes);
      await loadFiles();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Step failed.");
    } finally {
      setBusy("");
    }
  };

  const folder = (key: keyof Folders["folders"], title: string) => files?.paths[key] ? <div className="run-folder">
    <div className="run-folder-head"><b>{title}</b><code>{files.paths[key]}</code></div>
    {files.folders[key].length === 0 ? <small className="muted">Empty</small> :
      <ul>{files.folders[key].map(f => <li key={f.name}><span>{f.name}</span><small>{f.rows} row(s)</small></li>)}</ul>}
  </div> : null;

  return <div className="run-panel">
    <div className="run-panel-head">
      <div><h3>Run {integration.name}</h3><p>Sandbox folders stand in for {integration.transport === "sftp" ? "SFTP" : "the transfer"}: no real lab or server is contacted. Demo patients only.</p></div>
      <Button variant="outline" size="sm" onClick={() => void loadFiles()}><RefreshCw size={14} /> Refresh folders</Button>
    </div>

    <div className="run-steps">
      <div className="run-step">
        <span className="run-step-no">1</span>
        <div><b>Send orders</b><small>Healjour writes an orders CSV to the outbound folder, with lab column names and "{integration.delimiter === "\t" ? "Tab" : integration.delimiter}" as delimiter.</small></div>
        {sends ? <div className="run-step-actions">
          <input type="number" min={1} max={50} value={count} onChange={e => setCount(e.target.value)} aria-label="Number of orders" />
          <Button size="sm" disabled={Boolean(busy)} onClick={() => void step("send", `/api/integrations/${integration.id}/send`, { count: Number(count) }, d => `Sent ${d.orders} order(s) in ${d.file}.`)}>{busy === "send" ? "Sending…" : "Send orders"}</Button>
        </div> : <small className="muted">This integration only receives.</small>}
      </div>
      <div className="run-step">
        <span className="run-step-no">2</span>
        <div><b>Lab works on them (simulator)</b><small>Stands in for the lab: picks up the orders file and puts a results CSV in the inbound folder.</small></div>
        {sends && receives ? <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void step("lab", `/api/integrations/${integration.id}/simulate-lab`, {}, d => d.resultsFile ? `Lab picked up ${d.pickedUp.length} file(s) and sent back ${d.results} result(s) in ${d.resultsFile}.` : "No orders file was waiting. Send orders first.")}>{busy === "lab" ? "Working…" : "Run lab simulator"}</Button>
          : <small className="muted">Needs an integration that sends and receives.</small>}
      </div>
      <div className="run-step">
        <span className="run-step-no">3</span>
        <div><b>Receive results</b><small>Healjour reads the inbound folder, maps lab columns, applies the safety checks, and runs Healjour Core.</small></div>
        {receives ? <Button size="sm" disabled={Boolean(busy)} onClick={() => void step("receive", `/api/integrations/${integration.id}/receive`, {}, d => d.summary.files ? `Read ${d.summary.files} file(s): ${d.summary.imported} imported, ${d.summary.rejected} rejected, ${d.summary.duplicates} duplicate.` : "No results file was waiting in the inbound folder.")}>{busy === "receive" ? "Receiving…" : "Receive results"}</Button>
          : <small className="muted">This integration only sends.</small>}
      </div>
    </div>

    {message && <div className="access-message success">{message}</div>}
    {error && <div className="access-message error">{error}</div>}

    {outcomes.length > 0 && <div className="access-table-wrap"><table className="access-table">
      <thead><tr><th>RESULTS FILE</th><th>OUTCOME</th><th>ROWS</th><th>DELIVERED</th><th>HELD FOR REVIEW</th></tr></thead>
      <tbody>{outcomes.map(o => <tr key={o.file}>
        <td><b>{o.file}</b>{o.runId && <small>Core run {o.runId}</small>}</td>
        <td><span className={`core-layer-chip ${o.status === "imported" ? "passed" : o.status === "imported_with_issues" ? "warning" : "stopped"}`}>{OUTCOME_TEXT[o.status] ?? o.status}</span>
          {o.reason && <small>{o.reason}</small>}{(o.issues ?? []).map(i => <small key={i}>{i}</small>)}</td>
        <td>{o.rows}</td><td>{o.delivered ?? 0}</td><td>{o.quarantined ?? 0}</td>
      </tr>)}</tbody>
    </table></div>}

    <div className="run-folders">
      {folder("outbound", "Outbound (waiting for lab)")}
      {folder("pickedUp", "Picked up by lab")}
      {folder("inbound", "Inbound (waiting for Healjour)")}
      {folder("processed", "Processed")}
      {folder("rejected", "Rejected / duplicates")}
    </div>
  </div>;
}
