import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Copy, Download, RefreshCw, X } from "lucide-react";
import { WorkspaceTag, type WorkspaceTagData } from "./lib/record-tags";

type Status = "success" | "duplicate" | "error" | "info";
type LogType = "booking" | "sync" | "account" | "delivery" | "webhook" | "lab_portal";
type Log = {
  id: string; at: string; type: LogType; status: Status; account: string; title: string; message: string;
  integratorID?: string; leadId?: string; httpStatus?: number; details?: string[];
  workspace?: WorkspaceTagData;
};

const STATUS_TEXT: Record<Status, string> = {
  success: "Done",
  duplicate: "Already existed",
  error: "Failed",
  info: "Info"
};
const TYPE_TEXT: Record<LogType, string> = {
  webhook: "Webhook (from Flabs)",
  lab_portal: "Lab Portal (partner lab)",
  booking: "Booking (from form)",
  delivery: "Order (from lab)",
  sync: "Test sync",
  account: "Account"
};
const STATUS_HELP: Record<Status, string> = {
  success: "Flabs accepted it. Nothing to do.",
  duplicate: "This patient was already in Flabs today, so no new entry was created. Nothing to do.",
  error: "Something went wrong. Read the message below and fix the reason before sending again.",
  info: "For information only. Nothing to do."
};

const CHIP: Record<Status, { bg: string; fg: string; icon: typeof CheckCircle2 }> = {
  success: { bg: "#e7f9ee", fg: "#15803d", icon: CheckCircle2 },
  duplicate: { bg: "#d9f8f5", fg: "#0f766e", icon: AlertTriangle },
  error: { bg: "#fee2e2", fg: "#b91c1c", icon: X },
  info: { bg: "#e8f1ff", fg: "#1d4ed8", icon: CheckCircle2 }
};

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** Turns any http(s) address in a log line into a clickable link (for example a Flabs report URL). */
function linkify(text: string) {
  return text.split(/(https?:\/\/[^\s]+)/g).map((part, i) =>
    /^https?:\/\//.test(part)
      ? <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="log-link">{part}</a>
      : <span key={i}>{part}</span>
  );
}

/** Everything the Flabs integration did, in plain words. Click a row for the full details. */
export default function IntegrationLogs() {
  const [logs, setLogs] = useState<Log[]>([]);
  const [summary, setSummary] = useState({ total: 0, success: 0, duplicate: 0, error: 0, info: 0 });
  const [storage, setStorage] = useState<{ kind: string; durable: boolean } | null>(null);
  const [statusFilter, setStatusFilter] = useState<Status | "all">("all");
  const [typeFilter, setTypeFilter] = useState<LogType | "all">("all");
  const [accountFilter, setAccountFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/logs?limit=300");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load logs.");
      setLogs(data.logs);
      setSummary(data.summary);
      setStorage(data.storage);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect to the backend.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => void load(), 10000);
    return () => clearInterval(timer);
  }, [autoRefresh]);

  const accounts = useMemo(() => [...new Set(logs.map(l => l.account))].sort(), [logs]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return logs.filter(l =>
      (statusFilter === "all" || l.status === statusFilter) &&
      (typeFilter === "all" || l.type === typeFilter) &&
      (accountFilter === "all" || l.account === accountFilter) &&
      (!q || [l.title, l.message, l.integratorID, l.leadId, l.account].some(v => v?.toLowerCase().includes(q)))
    );
  }, [logs, statusFilter, typeFilter, accountFilter, search]);

  const copy = async (text: string) => {
    try { await navigator.clipboard?.writeText(text); setCopied(text); setTimeout(() => setCopied(""), 1500); } catch { /* clipboard blocked; nothing to do */ }
  };

  const card = (key: Status | "all", label: string, count: number, hint: string) => (
    <Button variant="ghost" key={key} className={cn("h-auto", `log-stat ${statusFilter === key ? "active" : ""}`)} onClick={() => setStatusFilter(key)}>
      <small>{label}</small><b>{count}</b><span>{hint}</span>
    </Button>
  );

  return <div className="content core-page flabs-theme">
    <div className="page-heading">
      <div>
        <div className="eyebrow">TRANSACTIONS & LOGS</div>
        <h1>What happened, when, and where</h1>
        <p>Every booking, sync and account change shows here. Click a row to see the full details.</p>
      </div>
      <div className="heading-actions">
        <label className="mini-check"><input type="checkbox" checked={autoRefresh} onChange={e => setAutoRefresh(e.target.checked)} /><span>Refresh every 10 seconds</span></label>
        <Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? "spin" : ""} /> Refresh</Button>
        <a className="btn-download" href="/api/logs/export?format=csv" download title="Download the whole log as a CSV file (opens in Excel)"><Download size={15} /> Download CSV</a>
        <a className="btn-download" href="/api/logs/export?format=json" download title="Download the log as JSON"><Download size={15} /> JSON</a>
      </div>
    </div>

    {error && <div className="access-message error"><X size={16} />{error}<Button className="h-auto" variant="ghost" onClick={() => setError("")}>Dismiss</Button></div>}
    {storage && !storage.durable && <div className="access-message error"><AlertTriangle size={16} />Logs are only kept in server memory. They will be lost when the server restarts.</div>}

    <div className="log-stats">
      {card("all", "All", summary.total, "Total entries")}
      {card("success", "Done", summary.success, STATUS_HELP.success)}
      {card("duplicate", "Already existed", summary.duplicate, STATUS_HELP.duplicate)}
      {card("error", "Failed", summary.error, STATUS_HELP.error)}
    </div>

    <section className="access-card">
      <div className="log-filters">
        <label className="field"><span>Type of work</span>
          <select value={typeFilter} onChange={e => setTypeFilter(e.target.value as LogType | "all")}>
            <option value="all">All</option>
            {(Object.keys(TYPE_TEXT) as LogType[]).map(t => <option key={t} value={t}>{TYPE_TEXT[t]}</option>)}
          </select>
        </label>
        <label className="field"><span>Account</span>
          <select value={accountFilter} onChange={e => setAccountFilter(e.target.value)}>
            <option value="all">All accounts</option>
            {accounts.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label className="field"><span>Search (name, ID, message)</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="e.g. shivam123 or a lead ID" />
        </label>
      </div>
      <p className="delivery-reason">Meaning: <b>Done</b> = Flabs accepted it · <b>Already existed</b> = duplicate · <b>Failed</b> = error, check the reason.</p>

      {shown.length === 0 ? <div className="empty-state"><b>No entries yet</b><p>Entries appear here after you send a booking or run a Flabs sync.</p></div> :
        <div className="log-table">
          <div className="log-row log-head">
            <span>When</span><span>What happened</span><span>Account</span><span>Transaction ID</span><span>Result</span><span />
          </div>
          {shown.map(l => {
            const chip = CHIP[l.status];
            const Icon = chip.icon;
            const expanded = open === l.id;
            return <div key={l.id} className={`log-entry log-${l.status}`}>
              <Button variant="ghost" className="h-auto log-row" onClick={() => setOpen(expanded ? null : l.id)}>
                <span className="log-when">{when(l.at)}</span>
                <span className="log-what"><b>{l.title}</b><small>{TYPE_TEXT[l.type]}</small></span>
                <span className="log-account">{l.account}{l.workspace && <WorkspaceTag workspace={l.workspace} compact />}</span>
                <span className="log-id">{l.leadId ? <><code>{l.leadId}</code></> : l.integratorID ? <code>{l.integratorID}</code> : <span className="muted">—</span>}</span>
                <span className="log-result" style={{ background: chip.bg, color: chip.fg }}><Icon size={13} /> {STATUS_TEXT[l.status]}</span>
                {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </Button>
              {expanded && <div className="log-detail">
                <p><b>Meaning:</b> {STATUS_HELP[l.status]}</p>
                <p><b>Message:</b> {linkify(l.message)}</p>
                {l.httpStatus && <p><b>Flabs HTTP code:</b> {l.httpStatus}</p>}
                {l.integratorID && <p><b>Your integrator ID:</b> <code>{l.integratorID}</code> <Button variant="ghost" className="h-auto tiny-copy" onClick={() => void copy(l.integratorID!)}><Copy size={11} /> {copied === l.integratorID ? "Copied" : "Copy"}</Button></p>}
                {l.leadId && <p><b>Transaction ID:</b> <code>{l.leadId}</code> <Button variant="ghost" className="h-auto tiny-copy" onClick={() => void copy(l.leadId!)}><Copy size={11} /> {copied === l.leadId ? "Copied" : "Copy"}</Button></p>}
                {l.details && l.details.length > 0 && <ul className="log-details">{l.details.map((d, i) => <li key={i}>{linkify(d)}</li>)}</ul>}
                <p className="muted">Entry ID: {l.id} · {new Date(l.at).toLocaleString()}</p>
              </div>}
            </div>;
          })}
        </div>}
    </section>
  </div>;
}
