import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEffect, useState } from "react";
import { Building2, Check, Copy, Plug, RefreshCw, Layers, ShieldCheck, Webhook, X } from "lucide-react";

type Conn = {
  id: string; label: string; clientIdMasked: string; branchId: string | null; phase: string;
  party: { field: string; id: string } | null; isDefault: boolean; secretStorage: string; mappedTests: number;
  webhookRegistered?: boolean;
};
type Log = { id: string; at: string; status: string; type: string; account: string; title: string; details?: string[] };
type Topology = { connectors: Array<{ id: string; label: string; description: string }> };

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

function useLive() {
  const [connections, setConnections] = useState<Conn[]>([]);
  const [logs, setLogs] = useState<Log[]>([]);
  const [topology, setTopology] = useState<Topology | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true); setError("");
    try {
      const [c, l, t] = await Promise.all([
        fetch("/api/flabs/connections").then(r => r.json()),
        fetch("/api/logs?limit=300").then(r => r.json()),
        fetch("/api/core/topology").then(r => r.json())
      ]);
      setConnections(c.connections ?? []);
      setLogs(l.logs ?? []);
      setTopology(t);
    } catch {
      setError("Could not load data. Check that the server is running.");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);
  return { connections, logs, topology, loading, error, reload: load };
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return <div className="platform-stat"><small>{label}</small><b>{value}</b><span>{hint}</span></div>;
}

function Header({ title, description, onReload, loading }: { title: string; description: string; onReload: () => void; loading: boolean }) {
  return <div className="page-heading">
    <div><div className="eyebrow">HEALJOUR INTEGRATION HUB</div><h1>{title}</h1><p>{description}</p></div>
    <div className="heading-actions"><Button variant="outline" onClick={onReload} disabled={loading}><RefreshCw size={15} className={loading ? "spin" : ""} /> Refresh</Button></div>
  </div>;
}

export function MonitoringPage() {
  const d = useLive();
  const relevant = d.logs.filter(l => l.type === "booking" || l.type === "delivery");
  const ok = relevant.filter(l => l.status === "success" || l.status === "duplicate").length;
  const failed = relevant.filter(l => l.status === "error");
  const rate = relevant.length ? Math.round((ok / relevant.length) * 100) : null;
  const times = d.logs
    .flatMap(l => l.details ?? [])
    .map(x => /Total time: (\d+)ms/.exec(x))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => Number(m[1]));
  const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;

  return <div className="content core-page flabs-theme">
    <Header title="Monitoring & SLA" description="How well integrations are working, based on Transactions & Logs." onReload={d.reload} loading={d.loading} />
    {d.error && <div className="access-message error">{d.error}</div>}
    <div className="platform-stats">
      <Stat label="Success rate" value={rate === null ? "—" : `${rate}%`} hint={`${ok} of ${relevant.length} sends went through`} />
      <Stat label="Failed sends" value={failed.length} hint="Booking or order not delivered" />
      <Stat label="Average delivery time" value={avg === null ? "—" : `${avg} ms`} hint="Time to deliver an order to Flabs" />
      <Stat label="Accounts connected" value={d.connections.length} hint="Flabs CRM accounts" />
    </div>
    <section className="access-card">
      <div className="access-card-head"><div><h2>Recent failures</h2><p>Open the row in Transactions & Logs to see the reason.</p></div></div>
      {failed.length === 0 ? <div className="empty-state"><b>No failures</b><p>Everything sent so far went through.</p></div> :
        <div className="platform-list">{failed.slice(0, 10).map(l => <div key={l.id} className="platform-row">
          <span className="core-layer-chip failed">Failed</span><b>{l.title}</b><small>{l.account}</small><span className="muted">{when(l.at)}</span>
        </div>)}</div>}
    </section>
  </div>;
}

const API_ENDPOINTS: Array<{ method: string; path: string; purpose: string }> = [
  { method: "GET", path: "/api/health", purpose: "Server status and where data is stored" },
  { method: "GET", path: "/api/catalog", purpose: "Healjour tests and packages" },
  { method: "POST", path: "/api/catalog/tests", purpose: "Add or update a test" },
  { method: "POST", path: "/api/catalog/packages", purpose: "Add or update a package" },
  { method: "GET", path: "/api/flabs/connections", purpose: "Connected Flabs accounts (secrets are never returned)" },
  { method: "POST", path: "/api/flabs/test", purpose: "Check a Flabs login and list its branches" },
  { method: "POST", path: "/api/flabs/connections", purpose: "Save a Flabs account" },
  { method: "POST", path: "/api/flabs/connections/:id/sync", purpose: "Match tests and packages with Flabs" },
  { method: "GET", path: "/api/flabs/connections/:id/tests", purpose: "Live Flabs test list for one account" },
  { method: "GET", path: "/api/flabs/booking-options", purpose: "Tests and packages for the booking form" },
  { method: "POST", path: "/api/flabs/bookings", purpose: "Send a lead or booking to Flabs" },
  { method: "POST", path: "/api/flabs/prebookings", purpose: "Create a Flabs pre-booking (starts billing, returns preBookingID)" },
  { method: "GET", path: "/api/integrations", purpose: "Lab integrations saved from Integration Studio" },
  { method: "POST", path: "/api/integrations", purpose: "Save an Integration Studio draft (same lab code updates it)" },
  { method: "POST", path: "/api/integrations/:id/test", purpose: "Run the synthetic checks for one saved integration" },
  { method: "POST", path: "/api/core/pipeline/run", purpose: "Run a lab payload through the four Core layers" },
  { method: "GET", path: "/api/logs", purpose: "Transactions and logs" }
];

function CodeSample({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return <div className="dev-code-wrap">
    <pre className="dev-code"><code>{code}</code></pre>
    <Button variant="outline" size="sm" className="dev-copy" onClick={() => void copy()}>
      {copied ? <Check size={14}/> : <Copy size={14}/>} {copied ? "Copied" : "Copy"}
    </Button>
  </div>;
}

function DevelopersSection({ base }: { base: string }) {
  const samples = {
    curl: `curl ${base}/api/health`,
    typescript: `const res = await fetch("${base}/api/health");\nconst health = await res.json();\nconsole.log(health.storage.kind); // "mongodb" or "memory"`,
    python: `import requests\n\nhealth = requests.get("${base}/api/health").json()\nprint(health["storage"]["kind"])  # "mongodb" or "memory"`
  };
  const points = [
    { icon: ShieldCheck, title: "Lab codes always match", text: "Every Healjour test and package maps to a Flabs ID, so bookings go out with valid codes." },
    { icon: Webhook, title: "Repeated events are safe", text: "Duplicate Flabs webhooks are detected, so a retry never creates a second update." },
    { icon: Layers, title: "Every event is logged", text: "Each booking, sync and webhook shows up in Transactions & Logs with its outcome." }
  ];
  return <section className="access-card dev-section">
    <div className="access-card-head"><div><div className="eyebrow">FOR DEVELOPERS</div><h2>Connect to Healjour in a few lines</h2><p>Use the same base URL above. Try the health check first, then add your own calls.</p></div></div>
    <div className="dev-points">
      {points.map(p => <div key={p.title} className="dev-point"><div className="dev-point-icon"><p.icon size={18}/></div><div><b>{p.title}</b><small>{p.text}</small></div></div>)}
    </div>
    <Tabs defaultValue="curl">
      <TabsList>
        <TabsTrigger value="curl">cURL</TabsTrigger>
        <TabsTrigger value="typescript">TypeScript</TabsTrigger>
        <TabsTrigger value="python">Python</TabsTrigger>
      </TabsList>
      <TabsContent value="curl"><CodeSample code={samples.curl}/></TabsContent>
      <TabsContent value="typescript"><CodeSample code={samples.typescript}/></TabsContent>
      <TabsContent value="python"><CodeSample code={samples.python}/></TabsContent>
    </Tabs>
    <p className="dev-note">Expected reply: a JSON object with <code>status: "ok"</code>. Demo data resets when the server restarts, unless MongoDB is connected.</p>
  </section>;
}

export function ApiPage() {
  const d = useLive();
  const [publicBase, setPublicBase] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/health").then(r => r.json()).then(j => setPublicBase(j.publicBaseUrl ?? null)).catch(() => setPublicBase(null));
  }, []);
  const base = publicBase ?? window.location.origin;
  return <div className="content core-page flabs-theme">
    <Header title="API & Webhooks" description="The endpoints Healjour exposes, and the webhooks it can receive." onReload={d.reload} loading={d.loading} />
    <section className="access-card">
      <div className="access-card-head"><div><h2>Base URL</h2><p>{publicBase ? "Public address (used by Flabs for webhooks)." : "Local address only. Set PUBLIC_BASE_URL to expose it to Flabs."}</p></div></div>
      <code className="base-url">{base}</code>
    </section>
    <DevelopersSection base={base} />
    <section className="access-card">
      <div className="access-card-head"><div><h2>Endpoints</h2><p>What each one does.</p></div></div>
      <div className="access-table-wrap"><table className="access-table">
        <thead><tr><th>METHOD</th><th>PATH</th><th>PURPOSE</th></tr></thead>
        <tbody>{API_ENDPOINTS.map(e => <tr key={e.method + e.path}>
          <td><span className={`method-chip ${e.method.toLowerCase()}`}>{e.method}</span></td>
          <td><code>{e.path}</code></td><td>{e.purpose}</td>
        </tr>)}</tbody>
      </table></div>
    </section>
    <section className="access-card">
      <div className="access-card-head"><div><h2>Flabs webhooks</h2><p>Flabs sends lead, booking and report events to Healjour. Register them from Test Catalog → Flabs CRM accounts.</p></div></div>
      <div className="access-table-wrap"><table className="access-table">
        <thead><tr><th>ACCOUNT</th><th>STATUS</th><th>RECEIVER URL</th></tr></thead>
        <tbody>{d.connections.map(c => <tr key={c.id}>
          <td><b>{c.label}</b></td>
          <td><span className={`core-layer-chip ${c.webhookRegistered ? "passed" : "skipped"}`}>{c.webhookRegistered ? "Registered" : "Not registered"}</span></td>
          <td>{c.webhookRegistered && publicBase ? <code>{publicBase}/api/webhooks/flabs/…</code> : <span className="muted">{publicBase ? "Click Register webhooks on the account" : "Set PUBLIC_BASE_URL first"}</span>}</td>
        </tr>)}</tbody>
      </table></div>
      {d.connections.length === 0 && <p className="delivery-reason">No Flabs account connected yet.</p>}
    </section>
  </div>;
}

export function SettingsPage() {
  const d = useLive();
  const [storage, setStorage] = useState<{ kind: string; durable: boolean; detail: string } | null>(null);
  const [keySet, setKeySet] = useState<boolean | null>(null);
  useEffect(() => {
    fetch("/api/health").then(r => r.json()).then(j => setStorage(j.storage ?? null)).catch(() => setStorage(null));
    fetch("/api/flabs/connections").then(r => r.json()).then(j => setKeySet(Boolean(j.canPersistSecret))).catch(() => setKeySet(null));
  }, []);
  const defaultAccount = d.connections.find(c => c.isDefault);

  return <div className="content core-page flabs-theme">
    <Header title="Settings" description="How this installation is set up. These values come from the server and are shown here read-only." onReload={() => { void d.reload(); }} loading={d.loading} />
    <section className="access-card">
      <div className="access-card-head"><div><h2>Data storage</h2><p>Where patients, logs and catalog data are kept.</p></div>
        <span className={`access-status ${storage?.durable ? "approved" : "pending"}`}>{storage?.durable ? "Durable" : "In memory"}</span></div>
      <div className="settings-grid">
        <div><small>Store</small><b>{storage?.kind === "mongodb" ? "MongoDB" : storage?.kind ?? "—"}</b></div>
        <div><small>Connection</small><code>{storage?.detail ?? "—"}</code></div>
        <div><small>Data kept after restart</small><b>{storage?.durable ? "Yes" : "No"}</b></div>
      </div>
    </section>
    <section className="access-card">
      <div className="access-card-head"><div><h2>Flabs secrets</h2><p>Client secrets are stored encrypted only when the server key is set.</p></div>
        <span className={`access-status ${keySet ? "approved" : "pending"}`}>{keySet ? "Encrypted" : "Memory only"}</span></div>
      {keySet === false && <div className="access-message error">FLABS_SECRET_KEY is not set. Flabs accounts are lost on restart and must be entered again.</div>}
    </section>
    <SecretSettings />
    <section className="access-card">
      <div className="access-card-head"><div><h2>Flabs defaults</h2><p>New orders go to the default account unless one is chosen.</p></div></div>
      <div className="settings-grid">
        <div><small>Default account</small><b>{defaultAccount?.label ?? "None"}</b></div>
        <div><small>Connected accounts</small><b>{d.connections.length}</b></div>
        <div><small>Mapped tests (all accounts)</small><b>{d.connections.reduce((s, c) => s + c.mappedTests, 0)}</b></div>
      </div>
    </section>
    <section className="access-card">
      <div className="access-card-head"><div><h2>Access</h2><p>There is no login yet. Anyone who can open the app can change integrations.</p></div><span className="core-layer-chip failed">Not set up</span></div>
    </section>
  </div>;
}

export function MarketplacePage() {
  const d = useLive();
  const flabsConnected = d.connections.length > 0;
  const planned = ["Razorpay (payments)", "HDFC SmartGATEWAY (payments)", "LeadSquared (CRM)", "Zoho Bookings (CRM)", "Exotel (telephony)", "Gmail and Google Workspace (email and calendar)", "Bahmni and KareXpert (HIS)"];

  return <div className="content core-page flabs-theme">
    <Header title="Connector Marketplace" description="Integrations that are built and ready, and the ones planned next." onReload={d.reload} loading={d.loading} />
    <section className="access-card">
      <div className="access-card-head"><div><h2>Available</h2><p>Built and usable now.</p></div></div>
      <div className="platform-list">
        <div className="platform-row integration-row">
          <span className="platform-icon"><Building2 size={16} /></span>
          <div><b>Flabs CRM</b><small>Send leads and bookings, match tests and packages, multiple accounts (lab, corporate, referral).</small></div>
          <span className={`core-layer-chip ${flabsConnected ? "passed" : "skipped"}`}>{flabsConnected ? "Connected" : "Not connected"}</span>
        </div>
        {(d.topology?.connectors ?? []).map(c => <div key={c.id} className="platform-row integration-row">
          <span className="platform-icon"><Layers size={16} /></span>
          <div><b>{c.label}</b><small>{c.description}</small></div>
          <span className="core-layer-chip passed">Available</span>
        </div>)}
      </div>
    </section>
    <section className="access-card">
      <div className="access-card-head"><div><h2>Planned</h2><p>Not built yet. Listed so the roadmap is visible.</p></div></div>
      <div className="platform-list">{planned.map(p => <div key={p} className="platform-row integration-row">
        <span className="platform-icon"><Plug size={16} /></span><div><b>{p}</b></div><span className="core-layer-chip skipped">Planned</span>
      </div>)}</div>
    </section>
  </div>;
}

/** Secrets and addresses that can be set from the screen. The key is created here and never shown. */
export function SecretSettings() {
  const [status, setStatus] = useState<{ encryptionKeySet: boolean; publicBaseUrl: string | null; settingsFile: string } | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = async () => {
    const res = await fetch("/api/settings");
    if (res.ok) {
      const data = await res.json();
      setStatus(data);
      setUrl(data.publicBaseUrl ?? "");
    }
  };
  useEffect(() => { void load(); }, []);

  const run = async (task: () => Promise<Response>) => {
    setBusy(true); setError(""); setMessage("");
    try {
      const res = await task();
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Something went wrong.");
      setMessage(data.message);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const createKey = () => run(() => fetch("/api/settings/encryption-key", { method: "POST" }));
  const saveUrl = () => run(() => fetch("/api/settings/public-base-url", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url })
  }));

  return <section className="access-card">
    <div className="access-card-head">
      <div><h2>Secrets and public address</h2><p>Saved on this computer in {status?.settingsFile ?? ".secrets/app.env"} (git-ignored). The key is never shown here.</p></div>
    </div>
    <div className="settings-grid">
      <div>
        <small>Encryption key</small>
        <b>{status?.encryptionKeySet ? "Created" : "Not created"}</b>
        {!status?.encryptionKeySet && <Button variant="default" size="sm" disabled={busy} onClick={() => void createKey()}>Create encryption key</Button>}
      </div>
      <div>
        <small>Public address (for Flabs webhooks)</small>
        <div className="settings-inline">
          <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://your-tunnel-address" disabled={busy} />
          <Button variant="default" size="sm" disabled={busy || !url.trim()} onClick={() => void saveUrl()}>Save</Button>
        </div>
      </div>
    </div>
    {message && <div className="access-message success">{message}</div>}
    {error && <div className="access-message error"><X size={16} />{error}</div>}
  </section>;
}
