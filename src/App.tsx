import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Wand2, Building2, ClipboardList, LogOut,
  Activity, ArrowDownUp, ArrowLeft, ArrowRight, Bell, Check, CheckCircle2,
  ChevronDown, CircleHelp, Clock3, Code2, Database, FileCheck2, FileSpreadsheet,
  FlaskConical, Gauge, GitCompareArrows, LayoutDashboard, LockKeyhole, Plug,
  Plus, RefreshCw, Save, Settings2, ShieldCheck, Upload, Workflow, X, KeyRound, Copy, RotateCw, Ban, UserCheck, UserX, Layers, Cable, Network, Search, ListChecks, FileText, CalendarDays
} from "lucide-react";
import CoreLayers from "./CoreLayers";
import TestCatalog from "./TestCatalog";
import TestBuilder from "./TestBuilder";
import { NotificationBell } from "./portal/NotificationBell";
import ConnectorFramework from "./ConnectorFramework";
import IntegrationHub from "./hub/IntegrationHub";
import CorporateMapping from "./CorporateMapping";
import { AdminLabCases, AdminLabsUsers } from "./portal/AdminPortal";
import type { PortalUser } from "./portal/api";
import { OrdersPage } from "./Calendar";
import IntegrationLogs from "./IntegrationLogs";
import { OverviewPage, OrganizationsPage, IntegrationsPage } from "./PlatformPages";
import { MonitoringPage, ApiPage, SettingsPage, MarketplacePage } from "./PlatformPagesExtra";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel,
  SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger
} from "@/components/ui/sidebar";

type Direction = "both" | "outbound" | "inbound";
type Transport = "sftp" | "managed_gateway" | "local_folder";
type Step = 0 | 1 | 2 | 3 | 4;

const steps = [
  { title: "Name & direction", subtitle: "What this connection is for" },
  { title: "Where files go", subtitle: "Folder and check schedule" },
  { title: "Match the columns", subtitle: "Lab columns to Healjour fields" },
  { title: "Safety checks", subtitle: "What to hold for review" },
  { title: "Test & go live", subtitle: "Check before going live" }
];

const outboundRows = [
  ["order_id", "LabOrderRef", "Required"],
  ["patient_ref", "PatientCode", "Required"],
  ["test_code", "InvestigationCode", "Lookup"],
  ["priority", "Priority", "Value map"],
  ["ordered_at", "OrderDate", "Date format"]
];
const inboundRows = [
  ["LabOrderRef", "order_id", "Required"],
  ["AccessionNo", "accession_number", "Required"],
  ["LabStatus", "sample_status", "Value map"],
  ["ResultValue", "result_value", "Conditional"],
  ["Approved", "approval_status", "Required"]
];

type PartnerLab = {
  id: string; name: string; labCode: string; status: "pending" | "approved" | "rejected";
  requestedAt: string; reviewedAt?: string; credentialStatus: "not_created" | "active" | "revoked";
  clientId?: string; scopes: string[]; createdAt?: string; rotatedAt?: string; revokedAt?: string; version: number;
};
type IssuedCredential = { clientId: string; clientSecret: string; scopes: string[]; version: number; secretShownOnce: true };
const scopeOptions = [
  { id: "orders:read", title: "Read orders", description: "Fetch order details and current order state." },
  { id: "orders:write", title: "Create orders", description: "Submit orders to the lab integration." },
  { id: "results:read", title: "Read results", description: "Retrieve result status and mapped values." },
  { id: "results:write", title: "Submit results", description: "Send validated result updates to Healjour." },
  { id: "reports:read", title: "Read reports", description: "Access report metadata/reference through an approved API." }
];

function PartnerAccess() {
  const [labs, setLabs] = useState<PartnerLab[]>([]);
  const [role, setRole] = useState<"admin" | "lab">("admin");
  const [selectedId, setSelectedId] = useState("lab-noida");
  const [scopes, setScopes] = useState<string[]>(["orders:read", "orders:write", "results:write"]);
  const [issued, setIssued] = useState<IssuedCredential | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [modeNote, setModeNote] = useState("Demo mode: role selector is for preview only, not authentication.");
  const selected = labs.find(l => l.id === selectedId);

  const loadLabs = async () => {
    try {
      const res = await fetch("/api/partner-access/labs");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load partner registry.");
      setLabs(data.labs || []);
      setModeNote(data.note || "Demo partner registry loaded.");
      if (!(data.labs || []).some((l: PartnerLab) => l.id === selectedId) && data.labs?.[0]) setSelectedId(data.labs[0].id);
    } catch (e) { setError(e instanceof Error ? e.message : "API unavailable. Start the backend server."); }
  };
  useEffect(() => { void loadLabs(); }, []);

  const act = async (path: string, body: unknown = {}) => {
    setBusy(true); setError(""); setNotice(""); setIssued(null);
    try {
      const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed.");
      if (data.issued) setIssued(data.issued);
      setNotice(data.message || data.warning || "Request completed.");
      await loadLabs();
    } catch (e) { setError(e instanceof Error ? e.message : "Request failed."); }
    finally { setBusy(false); }
  };
  const toggleScope = (scope: string) => setScopes(old => old.includes(scope) ? old.filter(s => s !== scope) : [...old, scope]);
  const selectedLab = selected;
  const date = (value?: string) => value ? new Date(value).toLocaleString() : "—";

  return <div className="content access-page">
    <div className="page-heading"><div><div className="eyebrow">PARTNER SECURITY & ONBOARDING</div><h1>API credentials</h1><p>Approve lab access, issue scoped credentials, rotate secrets, and revoke access.</p></div><div className="heading-actions"><Button variant="outline" onClick={() => void loadLabs()} disabled={busy}><RefreshCw size={15}/> Refresh</Button></div></div>
    <div className="access-warning"><ShieldCheck size={18}/><div><b>Demo implementation — not production authentication</b><p>{modeNote} Data is held in memory and resets when the server restarts. Do not use real patient data or production secrets.</p></div></div>
    <div className="access-rolebar"><div><b>Preview portal as</b><small>Switch between the Healjour admin workflow and a lab's self-service portal.</small></div><div className="segmented"><Button variant="ghost" className={cn("h-auto", role === "admin" ? "selected" : "")} onClick={() => {setRole("admin");setIssued(null);setNotice("");}}>Healjour admin</Button><Button variant="ghost" className={cn("h-auto", role === "lab" ? "selected" : "")} onClick={() => {setRole("lab");setIssued(null);setNotice("");}}>Lab portal</Button></div></div>
    {role === "admin" ? <>
      <div className="access-stats"><div className="access-stat"><small>Lab requests</small><b>{labs.length}</b></div><div className="access-stat"><small>Pending approval</small><b>{labs.filter(l => l.status === "pending").length}</b></div><div className="access-stat"><small>Approved labs</small><b>{labs.filter(l => l.status === "approved").length}</b></div><div className="access-stat"><small>Active credentials</small><b>{labs.filter(l => l.credentialStatus === "active").length}</b></div></div>
      <section className="access-card"><div className="access-card-head"><div><h2>Lab access requests</h2><p>Approve a lab before it can generate credentials.</p></div><span className="status-badge draft">ADMIN REVIEW</span></div>
        <div className="access-table-wrap"><table className="access-table"><thead><tr><th>LAB</th><th>ACCESS STATUS</th><th>CREDENTIALS</th><th>REQUESTED</th><th>ACTION</th></tr></thead><tbody>{labs.map(lab => <tr key={lab.id}><td><b>{lab.name}</b><small>{lab.labCode}</small></td><td><span className={`access-status ${lab.status}`}>{lab.status}</span></td><td><span className={`access-status ${lab.credentialStatus}`}>{lab.credentialStatus.replace("_", " ")}</span></td><td>{date(lab.requestedAt)}</td><td><div className="access-row-actions">{lab.status !== "approved" ? <Button variant="default" size="sm" disabled={busy} onClick={() => void act(`/api/partner-access/labs/${lab.id}/decision`, {decision:"approved"})}><UserCheck size={14}/> Approve</Button> : <Button variant="outline" size="sm" disabled={busy || lab.credentialStatus === "active"} onClick={() => void act(`/api/partner-access/labs/${lab.id}/decision`, {decision:"rejected"})}><UserX size={14}/> Reject</Button>}<Button variant="outline" size="sm" onClick={() => {setSelectedId(lab.id);setRole("lab");setIssued(null);}}>View lab</Button></div></td></tr>)}</tbody></table></div>
      </section>
    </> : <>
      <div className="access-card lab-selector"><div className="access-card-head"><div><h2>Lab self-service portal</h2><p>Select the lab account currently signed in for this demo.</p></div><span className="status-badge draft">LAB PORTAL</span></div><label className="field"><span>Lab account</span><select value={selectedId} onChange={e => {setSelectedId(e.target.value);setIssued(null);setNotice("");setError("");}}>{labs.map(l => <option key={l.id} value={l.id}>{l.name} ({l.labCode})</option>)}</select></label>
        {selectedLab && <div className="lab-account-summary"><div className="lab-avatar"><FlaskConical size={21}/></div><div className="lab-summary-main"><b>{selectedLab.name}</b><small>{selectedLab.labCode}</small></div><span className={`access-status ${selectedLab.status}`}>{selectedLab.status}</span></div>}
      </div>
      {selectedLab && <section className="access-card"><div className="access-card-head"><div><h2>Client credentials</h2><p>Only approved labs can generate credentials. Secrets are displayed once.</p></div><span className={`access-status ${selectedLab.credentialStatus}`}>{selectedLab.credentialStatus.replace("_", " ")}</span></div>
        {selectedLab.status !== "approved" ? <div className="empty-state"><LockKeyhole size={26}/><b>Approval required</b><p>Healjour must approve this lab before it can create API credentials.</p></div> : <>
          <div className="client-id-panel"><div><small>Client ID</small><code>{selectedLab.clientId || "Not generated yet"}</code></div>{selectedLab.clientId && <Button variant="outline" size="sm" onClick={() => void navigator.clipboard?.writeText(selectedLab.clientId || "")}><Copy size={14}/> Copy ID</Button>}</div>
          <div className="scope-heading"><div><h3>API permissions</h3><p>Grant only the minimum scopes required by your integration.</p></div></div>
          <div className="scope-list">{scopeOptions.map(scope => <label key={scope.id} className="scope-option"><input type="checkbox" checked={scopes.includes(scope.id)} onChange={() => toggleScope(scope.id)} disabled={busy}/><span><b>{scope.title}</b><small>{scope.description}</small><code>{scope.id}</code></span></label>)}</div>
          {selectedLab.scopes.length > 0 && <div className="current-scopes"><b>Currently assigned permissions</b><div>{selectedLab.scopes.map(s => <span key={s} className="scope-chip">{s}</span>)}</div></div>}
          <div className="credential-actions">{selectedLab.credentialStatus !== "active" ? <Button variant="default" disabled={busy || scopes.length === 0} onClick={() => void act(`/api/partner-access/labs/${selectedLab.id}/credentials`, {scopes})}><KeyRound size={15}/> Generate credentials</Button> : <><Button variant="default" disabled={busy || scopes.length === 0} onClick={() => void act(`/api/partner-access/labs/${selectedLab.id}/rotate`, {scopes})}><RotateCw size={15}/> Rotate secret</Button><Button variant="destructive" disabled={busy} onClick={() => {if (window.confirm("Revoke this lab's active credentials? API access using this client will stop in the demo registry.")) void act(`/api/partner-access/labs/${selectedLab.id}/revoke`);}}><Ban size={15}/> Revoke credentials</Button></> }</div>
          <div className="credential-meta"><span>Credential version <b>v{selectedLab.version}</b></span><span>Created <b>{date(selectedLab.createdAt)}</b></span>{selectedLab.rotatedAt && <span>Last rotated <b>{date(selectedLab.rotatedAt)}</b></span>}{selectedLab.revokedAt && <span>Revoked <b>{date(selectedLab.revokedAt)}</b></span>}</div>
        </>}
      </section>}
    </>}
    {issued && <section className="secret-once"><div className="secret-once-title"><ShieldCheck size={20}/><div><b>Copy your new client secret now</b><p>This is the only time the secret is displayed. It is not included in the lab list or returned by future reads.</p></div></div><div className="secret-field"><div><small>Client ID</small><code>{issued.clientId}</code></div><Button variant="outline" size="sm" onClick={() => void navigator.clipboard?.writeText(issued.clientId)}><Copy size={14}/> Copy</Button></div><div className="secret-field secret-value"><div><small>Client Secret · shown once</small><code>{issued.clientSecret}</code></div><Button variant="default" size="sm" onClick={() => void navigator.clipboard?.writeText(issued.clientSecret)}><Copy size={14}/> Copy secret</Button></div><div className="scope-chips">{issued.scopes.map(s => <span key={s} className="scope-chip">{s}</span>)}</div><p className="secret-footnote"><LockKeyhole size={14}/> Store this secret in your server's secret manager. Never commit it to source control or expose it in browser/mobile code. These are demo credentials only.</p></section>}
    {error && <div className="access-message error"><X size={16}/>{error}<Button className="h-auto" variant="ghost" onClick={() => setError("")}>Dismiss</Button></div>}
    {notice && !issued && <div className="access-message success"><CheckCircle2 size={16}/>{notice}<Button className="h-auto" variant="ghost" onClick={() => setNotice("")}>Dismiss</Button></div>}
    <div className="access-bottom-note"><LockKeyhole size={15}/> Production requirements: real admin/lab authentication, tenant isolation, persistent audit log, TLS, rate limits, secret rotation policy, and approved Healjour API contracts.</div>
  </div>;
}

type AppProps = { user: PortalUser; modules?: string[]; superAdmin?: boolean; onLogout: () => void; onChangePassword: () => void };

function App({ user, modules = [], superAdmin = false, onLogout, onChangePassword }: AppProps) {
  const [activeNav, setActiveNav] = useState("Integration Studio");
  const [step, setStep] = useState<Step>(0);
  const [name, setName] = useState("Noida Lab — CSV Connector");
  const [labCode, setLabCode] = useState("LAB-NOIDA-01");
  const [direction, setDirection] = useState<Direction>("both");
  const [transport, setTransport] = useState<Transport>("sftp");
  const [delimiter, setDelimiter] = useState(",");
  const [polling, setPolling] = useState("5");
  const [outboundPath, setOutboundPath] = useState("/healjour/outbound/");
  const [inboundPath, setInboundPath] = useState("/healjour/inbound/");
  const [file, setFile] = useState<File | null>(null);
  const [testState, setTestState] = useState<"idle" | "running" | "passed" | "failed">("idle");
  const [testMessage, setTestMessage] = useState("No live connection test has been run.");
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState("");
  const [rules, setRules] = useState([true, true, true, true, true, true]);
  const [mappingTab, setMappingTab] = useState<"outbound" | "inbound">("outbound");

  // Top navbar sections; the sidebar lists the pages of the active section.
  const allSections = [
    { id: "integrations", label: "Integrations", group: "INTEGRATION PRODUCTS", items: [
      { label: "Integration Hub", icon: Network },
      { label: "Connector Framework", icon: Cable },
      { label: "Integrations", icon: Workflow },
      { label: "Integration Studio", icon: GitCompareArrows },
      { label: "Connector Marketplace", icon: Plug },
      { label: "Core Layers", icon: Layers }
    ] },
    { id: "labs", label: "Labs", group: "LABS & CATALOGUE", items: [
      { label: "Lab Cases", icon: ClipboardList },
      { label: "Labs & Users", icon: Building2 },
      { label: "Organizations", icon: FlaskConical },
      { label: "Test Catalog", icon: FileSpreadsheet },
      { label: "Corporate Mapping", icon: Building2 },
      { label: "Test Builder", icon: Wand2 }
    ] },
    { id: "orders", label: "Orders", group: "ORDERS & DATA", items: [
      { label: "Orders & Bookings", icon: FileCheck2 },
      { label: "Booking Tracker", icon: ListChecks },
      { label: "Results & Smart Reports", icon: FileText },
      { label: "Booking Calendar", icon: CalendarDays },
      { label: "Transactions & Logs", icon: Activity }
    ] },
    { id: "developers", label: "Developers", group: "DEVELOPERS", items: [
      { label: "API & Webhooks", icon: Code2 },
      { label: "Partner Access", icon: KeyRound },
      { label: "Monitoring & SLA", icon: Gauge }
    ] }
  ];
  // Each page belongs to a module; an admin sees only the modules their role allows (the server enforces the same).
  const NAV_MODULE: Record<string, string> = {
    "Integration Hub": "integrations", "Connector Framework": "integrations", "Integrations": "integrations", "Integration Studio": "integrations",
    "Connector Marketplace": "integrations", "Core Layers": "integrations",
    "Lab Cases": "labs", "Labs & Users": "labs", "Organizations": "labs",
    "Test Catalog": "catalog", "Corporate Mapping": "catalog", "Test Builder": "catalog",
    "Orders & Bookings": "orders", "Booking Tracker": "orders", "Results & Smart Reports": "orders", "Booking Calendar": "orders",
    "Transactions & Logs": "logs", "API & Webhooks": "developers", "Partner Access": "developers", "Monitoring & SLA": "developers",
    "Settings": "settings"
  };
  const canSee = (label: string) => label === "Overview" || !NAV_MODULE[label] || superAdmin || modules.includes(NAV_MODULE[label]);
  const sections = allSections.map(s => ({ ...s, items: s.items.filter(i => canSee(i.label)) })).filter(s => s.items.length > 0);
  const navItems = [{ label: "Overview", icon: LayoutDashboard }, ...sections.flatMap(s => s.items), ...(canSee("Settings") ? [{ label: "Settings", icon: Settings2 }] : [])];
  // A page the role does not allow is never shown: fall back to Home.
  useEffect(() => { if (!canSee(activeNav)) setActiveNav("Overview"); }, [activeNav, modules.join(","), superAdmin]);
  const activeSection = sections.find(s => s.items.some(i => i.label === activeNav)) ?? null;
  const [sectionId, setSectionId] = useState<string>(() => "integrations");
  useEffect(() => { if (activeSection) setSectionId(activeSection.id); }, [activeSection?.id]);
  const go = (label: string) => { setActiveNav(label); setNotice(""); };
  const [search, setSearch] = useState("");
  const matches = search.trim() ? navItems.filter(i => i.label.toLowerCase().includes(search.trim().toLowerCase())).slice(0, 6) : [];

  const config = useMemo(() => ({
    name: name.trim(),
    labCode: labCode.trim(),
    source: "healjour" as const,
    target: "lab" as const,
    protocol: "csv" as const,
    transport,
    delimiter,
    pollingMinutes: Number(polling),
    direction,
    outboundPath: outboundPath.trim(),
    inboundPath: inboundPath.trim(),
    validationRules: {
      requiredHeaders: rules[0],
      rejectUnknownTestCodes: rules[1],
      detectDuplicates: rules[2],
      validateDates: rules[3],
      requireApprovedResults: rules[4],
      quarantinePatientMismatch: rules[5]
    }
  }), [name, labCode, transport, delimiter, polling, direction, outboundPath, inboundPath, rules]);

  const validateLocal = () => {
    const errors: string[] = [];
    if (config.name.length < 3) errors.push("Integration name must be at least 3 characters.");
    if (!/^[A-Z0-9-]{3,40}$/.test(config.labCode)) errors.push("Lab code must use uppercase letters, numbers, or hyphens.");
    if (![1, 5, 15, 60].includes(config.pollingMinutes)) errors.push("Polling interval must be 1, 5, 15, or 60 minutes.");
    if (config.direction !== "inbound" && !config.outboundPath) errors.push("Outbound folder is required.");
    if (config.direction !== "outbound" && !config.inboundPath) errors.push("Inbound folder is required.");
    if (config.outboundPath && !config.outboundPath.startsWith("/")) errors.push("Outbound path must be an absolute path.");
    if (config.inboundPath && !config.inboundPath.startsWith("/")) errors.push("Inbound path must be an absolute path.");
    return errors;
  };

  const saveDraft = async () => {
    const errors = validateLocal();
    if (errors.length) { setNotice(errors.join(" ")); return; }
    try {
      const res = await fetch("/api/integrations", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config)
      });
      const data = await res.json();
      if (!res.ok) { setNotice((data.errors ?? [data.error ?? "Validation failed."]).join(" ")); return; }
      setSaved(true);
      setNotice(`${data.updated ? "Updated" : "Saved"} "${data.integration.name}" (${data.integration.labCode}) as a draft. See it under Integrations. Not deployed.`);
    } catch {
      setNotice("Backend unavailable, so the draft was not saved. Start the app and try again.");
    }
  };

  const runTest = async () => {
    const errors = validateLocal();
    if (errors.length) { setTestState("failed"); setTestMessage(errors.join(" ")); return; }
    setTestState("running");
    setTestMessage("Running configuration and fixture checks…");
    try {
      const res = await fetch("/api/integrations/test", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(config)
      });
      const data = await res.json();
      setTestState(res.ok ? "passed" : "failed");
      setTestMessage(data.message ?? (res.ok ? "Sandbox checks passed." : "Test failed."));
    } catch {
      setTestState("passed");
      setTestMessage("Local demo checks passed. No SFTP host was contacted and no production connection exists.");
    }
  };

  const importCsv = async (selected: File | null) => {
    setFile(selected);
    if (!selected) return;
    if (!selected.name.toLowerCase().endsWith(".csv")) {
      setNotice("Please choose a .csv file.");
      setFile(null);
      return;
    }
    const text = await selected.text();
    const firstLine = text.split(/\r?\n/)[0] ?? "";
    const headers = firstLine.split(delimiter).map(h => h.trim().replace(/^"|"$/g, ""));
    setNotice(`Sample file loaded: ${selected.name}. Detected ${headers.length} header(s): ${headers.join(", ") || "none"}. This is a local preview only.`);
  };

  const goNext = () => {
    if (step === 0 && (!name.trim() || !labCode.trim())) { setNotice("Enter an integration name and lab code."); return; }
    const errors = validateLocal();
    if (errors.length && step !== 2 && step !== 3) { setNotice(errors.join(" ")); return; }
    setNotice("");
    setStep(s => Math.min(4, s + 1) as Step);
  };

  const isWizard = activeNav === "Integration Studio";

  return (
    <SidebarProvider className="app-shell rz" style={{ "--sidebar-width": "256px", "--sidebar-width-icon": "60px" } as CSSProperties}>
      {/* Top navbar: brand, product sections, search, notifications, account */}
      <header className="rz-topnav">
        <div className="rz-brand" onClick={() => go("Overview")}><span className="rz-brand-mark"><Workflow size={16} /></span><b>healjour</b></div>
        <nav className="rz-sections" aria-label="Sections">
          {sections.map(s => <button key={s.id} type="button" className={sectionId === s.id ? "on" : ""} onClick={() => { setSectionId(s.id); go(s.items[0].label); }}>{s.label}</button>)}
        </nav>
        <div className="rz-search">
          <Search size={15} />
          <input placeholder="Search pages and settings" value={search} onChange={e => setSearch(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && matches[0]) { go(matches[0].label); setSearch(""); } if (e.key === "Escape") setSearch(""); }} aria-label="Search pages" />
          {matches.length > 0 && <ul className="rz-search-results">{matches.map(m => { const Icon = m.icon; return <li key={m.label}><button type="button" onClick={() => { go(m.label); setSearch(""); }}><Icon size={14} /> {m.label}</button></li>; })}</ul>}
        </div>
        <div className="rz-actions">
          {superAdmin && <a className="rz-super-link" href="/superadmin" title="Open the Super Admin console"><ShieldCheck size={15} /> Super Admin</a>}
          <NotificationBell />
          <button type="button" className="rz-icon" aria-label="Help" title="Help"><CircleHelp size={17} /></button>
          <div className="rz-avatar" title={user.name}>{user.name.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase()}</div>
        </div>
      </header>
      <div className="rz-notch" title="Partner connectors run against their sandboxes until live keys are set"><span className="rz-dot" /> SANDBOX</div>

      <Sidebar collapsible="icon">
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton isActive={activeNav === "Overview"} tooltip="Home" onClick={() => go("Overview")}><LayoutDashboard size={17}/><span>Home</span></SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          {/* Every section is always listed, so no page is hidden when the top tabs are not visible (small screens). */}
          {sections.map(section => <SidebarGroup key={section.id} className={sectionId === section.id ? "rz-group-on" : ""}>
            <SidebarGroupLabel className="nav-label">{section.group}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map(item => {
                  const Icon = item.icon;
                  return <SidebarMenuItem key={item.label}>
                    <SidebarMenuButton isActive={activeNav === item.label} tooltip={item.label} onClick={() => go(item.label)}>
                      <Icon size={17}/><span>{item.label}</span>{item.label === "Integration Hub" && <span className="rz-new">New</span>}
                    </SidebarMenuButton>
                  </SidebarMenuItem>;
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>)}
        </SidebarContent>
        <SidebarFooter>
          <div className="rz-env-row"><ShieldCheck size={16}/><span>Sandbox environment</span><span className="rz-env-badge">ON</span></div>
          <SidebarMenu>
            <SidebarMenuItem>
              {canSee("Settings") && <SidebarMenuButton isActive={activeNav === "Settings"} tooltip="Account & Settings" onClick={() => go("Settings")}><Settings2 size={17}/><span>Account &amp; Settings</span></SidebarMenuButton>}
            </SidebarMenuItem>
          </SidebarMenu>
          <div className="user-profile"><div className="user-avatar">{user.name.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase()}</div><div><b>{user.name}</b><small>{superAdmin ? "Super Admin" : "Healjour admin"}</small></div>
            <Button variant="ghost" className="h-auto icon-button" aria-label="Change password" title="Change password" onClick={onChangePassword}><KeyRound size={15}/></Button>
            <Button variant="ghost" className="h-auto icon-button" aria-label="Sign out" title="Sign out" onClick={onLogout}><LogOut size={15}/></Button></div>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <main className="main">
        <header className="topbar">
          <div className="breadcrumbs"><SidebarTrigger /> {activeSection ? activeSection.label : "Home"} <span>/</span> <b>{activeNav === "Overview" ? "Home" : activeNav}</b></div>
        </header>

        {activeNav === "Overview" ? <OverviewPage /> :  activeNav === "Monitoring & SLA" ? <MonitoringPage /> : activeNav === "API & Webhooks" ? <ApiPage /> : activeNav === "Settings" ? <SettingsPage /> : activeNav === "Connector Marketplace" ? <MarketplacePage /> : activeNav === "Organizations" ? <OrganizationsPage /> : activeNav === "Integrations" ? <IntegrationsPage /> : activeNav === "Connector Framework" ? <ConnectorFramework /> : activeNav === "Integration Hub" ? <IntegrationHub /> : activeNav === "Core Layers" ? <CoreLayers /> : activeNav === "Test Catalog" ? <TestCatalog /> : activeNav === "Corporate Mapping" ? <CorporateMapping /> : activeNav === "Test Builder" ? <TestBuilder /> : activeNav === "Lab Cases" ? <AdminLabCases /> : activeNav === "Labs & Users" ? <AdminLabsUsers me={user} /> : activeNav === "Orders & Bookings" ? <OrdersPage key="book" /> : activeNav === "Booking Tracker" ? <OrdersPage key="tracker" initialTab="tracker" /> : activeNav === "Results & Smart Reports" ? <OrdersPage key="results" initialTab="results" /> : activeNav === "Booking Calendar" ? <OrdersPage key="calendar" initialTab="calendar" /> : activeNav === "Transactions & Logs" ? <IntegrationLogs /> : activeNav === "Partner Access" ? <PartnerAccess /> : isWizard ? <div className="content">
          <div className="page-heading">
            <div><div className="eyebrow">INTEGRATION CONFIGURATION</div><h1>Create integration</h1><p>Set up how Healjour and a lab exchange CSV files, one simple step at a time.</p></div>
            <div className="heading-actions"><Button variant="outline" onClick={() => {setStep(0); setNotice("Wizard reset to step 1.");}}> <RefreshCw size={16}/> Reset wizard</Button><Button variant="default" onClick={saveDraft}><Save size={16}/> Save draft</Button></div>
          </div>

          <div className="integration-summary">
            <div className="summary-icon"><FileSpreadsheet size={23}/></div>
            <div className="summary-main"><div className="summary-title">{name || "Untitled integration"} <span className="status-badge draft">DRAFT</span></div><div className="summary-meta"><span><FlaskConical size={14}/> {labCode || "LAB-CODE"}</span><span><ArrowDownUp size={14}/> {direction === "both" ? "Sends & receives" : direction === "outbound" ? "Sends orders only" : "Receives results only"}</span><span><Clock3 size={14}/> Checks every {polling} min</span></div></div>
            <div className="summary-right"><span className="small-label">FILE FORMAT</span><b>CSV files</b></div>
          </div>

          <div className="flow-card">
            <div className="flow-step"><div className="flow-icon blue"><Workflow size={18}/></div><b>1. Healjour creates orders</b><small>Saved as a CSV file</small></div>
            <ArrowRight className="flow-arrow" size={18}/>
            <div className="flow-step"><div className="flow-icon orange"><FileSpreadsheet size={18}/></div><b>2. File goes to a shared folder</b><small>The lab picks it up every {polling} min</small></div>
            <ArrowRight className="flow-arrow" size={18}/>
            <div className="flow-step"><div className="flow-icon green"><FlaskConical size={18}/></div><b>3. Lab sends results back</b><small>Checked by Healjour before saving</small></div>
          </div>

          <div className="wizard-layout">
            <section className="wizard-steps">
              <div className="stepper-heading">SETUP WORKFLOW</div>
              {steps.map((s, i) => <Button variant="ghost" key={s.title} className={cn("h-auto", `step-item ${step === i ? "selected" : ""} ${step > i ? "completed" : ""}`)} onClick={() => setStep(i as Step)}>
                <div className="step-number">{step > i ? <Check size={16}/> : i + 1}</div><div className="step-copy"><b>{s.title}</b><small>{s.subtitle}</small></div>{step === i && <ArrowRight className="step-arrow" size={16}/>}
              </Button>)}
              <div className="steps-help"><div className="help-icon"><LockKeyhole size={18}/></div><b>Configuration stays private</b><p>Credentials should be stored in a secrets manager, never in this form or CSV files.</p><Button className="h-auto" variant="ghost" onClick={() => setNotice("Security guidance: use managed secrets, SFTP host-key verification, least privilege, and audited production approvals.")}>Security guidance <ArrowRight size={13}/></Button></div>
            </section>

            <section className="form-panel">
              {step === 0 && <div className="step-content">
                <div className="section-heading"><div><h2>Name & direction</h2><p>Give this connection a name and choose which way the data flows.</p></div><span className="step-count">STEP 01 / 05</span></div>
                <div className="plain-hint"><CircleHelp size={16}/><span>Start here. The name is just a label for your team. Direction decides whether orders go to the lab, results come back, or both.</span></div>
                <div className="form-grid">
                  <label className="field full"><span>Integration name <i>*</i></span><input value={name} onChange={e => {setName(e.target.value); setSaved(false);}} placeholder="e.g. Noida Lab — CSV Connector"/><small>Use a clear, unique name for the integration.</small></label>
                  <label className="field"><span>Lab code <i>*</i></span><input value={labCode} onChange={e => {setLabCode(e.target.value.toUpperCase()); setSaved(false);}} placeholder="LAB-NOIDA-01"/><small>3–40 uppercase letters, digits or hyphens.</small></label>
                  <label className="field"><span>Source system</span><div className="select-like"><div className="mini-icon blue"><Workflow size={16}/></div><div><b>Healjour</b><small>Canonical platform</small></div><CheckCircle2 size={17} className="green-icon"/></div></label>
                  <div className="field full"><span>Target system</span><div className="select-like"><div className="mini-icon orange"><FlaskConical size={16}/></div><div><b>Diagnostic Lab / LIS</b><small>Lab-specific CSV schema</small></div><span className="select-tag">EXTERNAL SYSTEM</span></div></div>
                  <div className="field full"><span>Data direction <i>*</i></span><div className="direction-options">
                    <Button variant="ghost" className={cn("h-auto", direction === "both" ? "direction-option chosen" : "direction-option")} onClick={() => setDirection("both")}><ArrowDownUp size={19}/><b>Send & receive</b><small>Orders go to the lab, results come back</small>{direction === "both" && <CheckCircle2 size={16}/>}</Button>
                    <Button variant="ghost" className={cn("h-auto", direction === "outbound" ? "direction-option chosen" : "direction-option")} onClick={() => setDirection("outbound")}><ArrowRight size={19}/><b>Send orders only</b><small>Healjour → Lab</small>{direction === "outbound" && <CheckCircle2 size={16}/>}</Button>
                    <Button variant="ghost" className={cn("h-auto", direction === "inbound" ? "direction-option chosen" : "direction-option")} onClick={() => setDirection("inbound")}><ArrowLeft size={19}/><b>Receive results only</b><small>Lab → Healjour</small>{direction === "inbound" && <CheckCircle2 size={16}/>}</Button>
                  </div></div>
                </div>
              </div>}

              {step === 1 && <div className="step-content">
                <div className="section-heading"><div><h2>Where files go</h2><p>Choose the folder where CSV files are stored and how often to check it.</p></div><span className="step-count">STEP 02 / 05</span></div>
                <div className="plain-hint"><CircleHelp size={16}/><span>Think of this as a shared folder. Healjour drops order files in one, and the lab drops result files in another.</span></div>
                <div className="info-banner"><LockKeyhole size={18}/><div><b>Demo only, not connected to a real lab</b><p>The lab's IT team will later provide the server address and login details. Nothing here connects to a real server.</p></div></div>
                <div className="form-grid">
                  <label className="field full"><span>Transport mechanism</span><select value={transport} onChange={e => setTransport(e.target.value as Transport)}><option value="sftp">SFTP — Secure File Transfer Protocol</option><option value="managed_gateway">Managed file gateway</option><option value="local_folder">Approved local folder / mounted volume</option></select></label>
                  <label className="field"><span>CSV delimiter</span><select value={delimiter} onChange={e => setDelimiter(e.target.value)}><option value=",">Comma (,)</option><option value="|">Pipe (|)</option><option value=";">Semicolon (;)</option><option value="	">Tab</option></select></label>
                  <label className="field"><span>Polling interval</span><select value={polling} onChange={e => setPolling(e.target.value)}><option value="1">Every 1 minute</option><option value="5">Every 5 minutes</option><option value="15">Every 15 minutes</option><option value="60">Every 60 minutes</option></select></label>
                  {direction !== "inbound" && <label className="field full"><span>Outbound folder path <i>*</i></span><input value={outboundPath} onChange={e => setOutboundPath(e.target.value)} placeholder="/healjour/outbound/"/><small>Orders exported by Healjour and picked up by the lab.</small></label>}
                  {direction !== "outbound" && <label className="field full"><span>Inbound folder path <i>*</i></span><input value={inboundPath} onChange={e => setInboundPath(e.target.value)} placeholder="/healjour/inbound/"/><small>Lab status and result files consumed by Healjour.</small></label>}
                  <div className="field full"><span>Recommended file naming</span><div className="code-line"><code>{direction !== "inbound" ? "orders_{yyyyMMddHHmmss}_{batchId}.csv" : "results_{yyyyMMddHHmmss}_{batchId}.csv"}</code><Button variant="ghost" className="h-auto tiny-copy" onClick={() => setNotice("Use unique batch IDs and atomic upload/rename. File naming pattern copied into design notes.")}>Use pattern</Button></div></div>
                </div>
              </div>}

              {step === 2 && <div className="step-content">
                <div className="section-heading"><div><h2>Match the columns</h2><p>Connect the lab's CSV column names to Healjour's fields.</p></div><span className="step-count">STEP 03 / 05</span></div>
                <div className="plain-hint"><CircleHelp size={16}/><span>Each row says: "this Healjour field is called this in the lab's file." Use a sample file from the lab to fill these in correctly.</span></div>
                <div className="mapping-toolbar"><div className="segmented"><Button variant="ghost" className={cn("h-auto", mappingTab === "outbound" ? "selected" : "")} onClick={() => setMappingTab("outbound")}>Outbound · Orders</Button><Button variant="ghost" className={cn("h-auto", mappingTab === "inbound" ? "selected" : "")} onClick={() => setMappingTab("inbound")}>Inbound · Results</Button></div><label className="upload-btn"><Upload size={15}/> Import sample CSV<input type="file" accept=".csv,text/csv" onChange={e => void importCsv(e.target.files?.[0] ?? null)} /></label></div>
                {file && <div className="file-chip"><FileSpreadsheet size={15}/><span>{file.name}</span><Button className="h-auto" variant="ghost" onClick={() => setFile(null)}><X size={14}/></Button></div>}
                <div className="mapping-table-wrap"><table className="mapping-table"><thead><tr><th>{mappingTab === "outbound" ? "HEALJOUR FIELD" : "LAB CSV COLUMN"}</th><th></th><th>{mappingTab === "outbound" ? "LAB CSV COLUMN" : "HEALJOUR FIELD"}</th><th>RULE</th></tr></thead><tbody>{(mappingTab === "outbound" ? outboundRows : inboundRows).map((r, i) => <tr key={r[0]}><td><code>{r[0]}</code></td><td><ArrowRight size={15}/></td><td><input className="mapping-input" defaultValue={r[1]}/></td><td><span className={`rule-pill ${i === 0 ? "required" : ""}`}>{r[2]}</span></td></tr>)}</tbody></table></div>
                <div className="mapping-note"><CircleHelp size={17}/><span>These are illustrative mappings. Import the lab's real sample file and confirm test codes, status values, units and date formats before deployment.</span></div>
                <div className="form-grid compact-grid"><label className="field"><span>Unknown test code behavior</span><select defaultValue="quarantine"><option value="quarantine">Quarantine row</option><option value="reject">Reject entire file</option></select></label><label className="field"><span>Duplicate handling</span><select defaultValue="skip"><option value="skip">Skip and audit</option><option value="quarantine">Quarantine duplicate</option></select></label></div>
              </div>}

              {step === 3 && <div className="step-content">
                <div className="section-heading"><div><h2>Safety checks</h2><p>Choose what Healjour must check before saving any record.</p></div><span className="step-count">STEP 04 / 05</span></div>
                <div className="plain-hint"><CircleHelp size={16}/><span>Keep all checks on. If a check fails, that record is held for a person to review instead of being saved.</span></div>
                <div className="rule-list">
                  {[
                    ["Required headers present","Reject files with missing required columns."],
                    ["Reject unknown test codes","Quarantine rows that have no approved catalog mapping."],
                    ["Detect duplicate records","Use file checksum and stable order/event identifiers."],
                    ["Validate dates and units","Parse according to the lab's agreed format; never silently convert unknown units."],
                    ["Require result approval","Do not publish a final result unless the lab approval state is valid."],
                    ["Quarantine patient mismatch","Block results that cannot be safely matched to the intended order."]
                  ].map((r, i) => <label key={r[0]} className="rule-row"><span className={`toggle ${rules[i] ? "on" : ""}`}><input type="checkbox" checked={rules[i]} onChange={e => setRules(old => old.map((v, j) => i === j ? e.target.checked : v))}/><span/></span><span className="rule-copy"><b>{r[0]}</b><small>{r[1]}</small></span><ShieldCheck size={18} className="rule-shield"/></label>)}
                </div>
                <div className="info-banner warning"><ShieldCheck size={18}/><div><b>Clinical data safety</b><p>Unknown units, ambiguous patient matches and unapproved results must be quarantined or blocked, not auto-corrected.</p></div></div>
              </div>}

              {step === 4 && <div className="step-content">
                <div className="section-heading"><div><h2>Test & go live</h2><p>Review your setup and run the checks before anything goes live.</p></div><span className="step-count">STEP 05 / 05</span></div>
                <div className="plain-hint"><CircleHelp size={16}/><span>Run the checks, then save. This demo never goes live, so nothing is sent to a real lab from here.</span></div>
                <div className="review-card"><div className="review-header"><div className="summary-icon"><FileSpreadsheet size={21}/></div><div><b>{name}</b><small>{labCode} · CSV connector</small></div><span className="status-badge draft">DRAFT</span></div><div className="review-grid"><div><small>Transport</small><b>{transport === "sftp" ? "SFTP" : transport === "managed_gateway" ? "Managed gateway" : "Local folder"}</b></div><div><small>Delimiter</small><b>{delimiter === "\t" ? "Tab" : delimiter === "," ? "Comma (,)" : delimiter}</b></div><div><small>Polling</small><b>{polling} minutes</b></div><div><small>Direction</small><b>{direction === "both" ? "Send & receive" : direction === "outbound" ? "Send orders only" : "Receive results only"}</b></div></div></div>
                <div className="test-actions"><Button variant="outline" onClick={saveDraft}><Save size={16}/> Validate & save draft</Button><Button variant="default" onClick={() => void runTest()} disabled={testState === "running"}>{testState === "running" ? <RefreshCw className="spin" size={16}/> : <Activity size={16}/>} {testState === "running" ? "Testing…" : "Run sandbox checks"}</Button></div>
                <div className={`test-result ${testState}`}><div className="test-result-icon">{testState === "failed" ? <X size={19}/> : testState === "passed" ? <CheckCircle2 size={19}/> : <Clock3 size={19}/>}</div><div><b>{testState === "passed" ? "Demo checks passed" : testState === "failed" ? "Checks need attention" : testState === "running" ? "Checks running" : "Ready to test"}</b><p>{testMessage}</p></div></div>
                <div className="deployment-note"><LockKeyhole size={18}/><div><b>Production deployment is intentionally disabled</b><p>This prototype does not store SFTP credentials, connect to a lab, send patient data or deploy a live connector. Production activation requires verified partner details, security review and authorized approval.</p></div></div>
              </div>}

              {notice && <div className="notice"><CircleHelp size={16}/><span>{notice}</span><Button className="h-auto" variant="ghost" onClick={() => setNotice("")}><X size={14}/></Button></div>}
              {saved && <div className="saved-note"><CheckCircle2 size={16}/> Draft validation completed. Not deployed.</div>}
              <div className="form-footer"><div className="autosave"><span className="autosave-dot"/>{saved ? "Draft validated" : "Changes not deployed"} <span className="separator">·</span> <span>Config v1 (draft)</span></div><div className="footer-buttons"><Button variant="outline" onClick={() => setStep(s => Math.max(0, s - 1) as Step)} disabled={step === 0}><ArrowLeft size={15}/> Back</Button>{step < 4 ? <Button variant="default" onClick={goNext}>Continue <ArrowRight size={15}/></Button> : <Button variant="outline" onClick={() => {setStep(0); setNotice("Wizard remains a draft. Production deployment is not available in this prototype.");}}>Close wizard <Check size={15}/></Button>}</div></div>
            </section>
          </div>
          <div className="bottom-footnote"><ShieldCheck size={15}/> Healthcare data safeguards enabled in the design · Use synthetic data for sandbox testing.</div>
        </div> : <div className="content placeholder-page">
          <div className="page-heading"><div><div className="eyebrow">HEALJOUR INTEGRATION HUB</div><h1>{activeNav}</h1><p>This area is part of the proposed product navigation.</p></div><Button variant="default" onClick={() => setActiveNav("Integration Studio")}><Plus size={16}/> Open Integration Studio</Button></div>
          <div className="placeholder-card"><div className="summary-icon"><Workflow size={24}/></div><h2>{activeNav}</h2><p>This prototype currently implements the Integration Studio configuration wizard. Other modules are navigation placeholders, not implemented production features.</p><Button variant="outline" onClick={() => setActiveNav("Integration Studio")}>Return to wizard <ArrowRight size={15}/></Button></div>
        </div>}
      </main>
    </SidebarProvider>
  );
}

export default App;