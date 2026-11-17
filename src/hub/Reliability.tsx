import { useEffect, useState } from "react";
import { BookOpen, Play, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, Empty, hubApi, ModeBadge, Msg, Pill, Stats, when } from "./shared";

type Alert = { id: string; at: string; lastAt: string; count: number; severity: "critical" | "warning" | "info"; source: string; title: string; detail: string; runbook: string; status: string; by?: string };
type Runbook = { title: string; when: string; steps: string[] };
type Job = { id: string; at: string; job: string; trigger: string; ok: boolean; durationMs: number; steps: Array<{ name: string; ok: boolean; summary: string }> };
type Data = { alerts: Alert[]; runbooks: Record<string, Runbook>; jobs: Job[]; channel: Array<{ at: string; text: string }>; modes: Record<string, string>; cronConfigured: boolean };

const SEV: Record<string, "bad" | "warn" | "info"> = { critical: "bad", warning: "warn", info: "info" };

export default function Reliability() {
  const [d, setD] = useState<Data | null>(null);
  const [filter, setFilter] = useState("open");
  const [book, setBook] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = async () => { try { setD(await hubApi<Data>("/api/hub/reliability")); } catch (e) { setError(e instanceof Error ? e.message : "Could not load."); } };
  useEffect(() => { void load(); }, []);
  const run = async (task: () => Promise<string>) => {
    setBusy(true); setError(""); setNotice("");
    try { setNotice(await task()); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Failed."); } finally { setBusy(false); }
  };
  if (!d) return <Msg error={error} />;
  const setStatus = (a: Alert, status: "acknowledged" | "resolved") => run(async () => { await hubApi(`/api/hub/alerts/${a.id}`, { body: { status } }); return `Alert ${status}.`; });
  const runJob = (job: "daily" | "dispatch") => run(async () => {
    const r = await hubApi<Job>(`/api/hub/jobs/${job}`, { body: {} });
    return `${job === "daily" ? "Daily checks" : "Reminder dispatcher"} finished in ${r.durationMs} ms${r.ok ? "" : " with a failed step"}.`;
  });
  const alerts = d.alerts.filter(a => filter === "all" ? true : filter === "open" ? a.status !== "resolved" : a.status === filter);
  const open = d.alerts.filter(a => a.status !== "resolved");

  return <div className="hub-stack">
    <Msg error={error} notice={notice} />
    <Stats items={[
      ["Open alerts", open.length, open.length ? "warn" : ""],
      ["Critical", open.filter(a => a.severity === "critical").length, open.some(a => a.severity === "critical") ? "warn" : ""],
      ["Last daily run", d.jobs.find(j => j.job === "daily") ? when(d.jobs.find(j => j.job === "daily")!.at) : "Never"],
      ["Scheduler", d.cronConfigured ? "On (CRON_SECRET set)" : "Manual only", d.cronConfigured ? "" : "warn"]
    ]} />

    <Card title="Alerts" sub="Raised when a call lands in dead letters, a connector fails often, reconciliation does not match, messages fail, leads wait, or reports are late. The same problem bumps one alert instead of creating many." right={<div className="hub-actions">
      <select className="hub-select" value={filter} onChange={e => setFilter(e.target.value)}><option value="open">Open</option><option value="acknowledged">Acknowledged</option><option value="resolved">Resolved</option><option value="all">All</option></select>
      <Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw size={13} /></Button>
    </div>}>
      {alerts.length === 0 ? <Empty>No alerts here.</Empty> : <ul className="hub-alerts">{alerts.map(a => <li key={a.id} className={`sev-${a.severity}`}>
        <div className="hub-alert-head"><Pill tone={SEV[a.severity]}>{a.severity}</Pill><b>{a.title}</b>{a.count > 1 && <Pill tone="muted">×{a.count}</Pill>}<Pill tone={a.status === "resolved" ? "ok" : a.status === "acknowledged" ? "info" : "warn"}>{a.status}</Pill></div>
        <p>{a.detail}</p>
        <small>{a.source} · first {when(a.at)} · last {when(a.lastAt)}{a.by ? ` · ${a.by}` : ""}</small>
        <div className="hub-actions">
          <Button variant="outline" size="sm" onClick={() => setBook(book === a.id ? null : a.id)}><BookOpen size={13} /> Runbook</Button>
          {a.status === "open" && <Button variant="outline" size="sm" disabled={busy} onClick={() => void setStatus(a, "acknowledged")}>Acknowledge</Button>}
          {a.status !== "resolved" && <Button variant="default" size="sm" disabled={busy} onClick={() => void setStatus(a, "resolved")}>Resolve</Button>}
        </div>
        {book === a.id && d.runbooks[a.runbook] && <RunbookView rb={d.runbooks[a.runbook]} />}
      </li>)}</ul>}
    </Card>

    <div className="hub-two">
      <Card title="Scheduled jobs" sub="Vercel Cron calls /api/cron/daily daily and /api/cron/dispatch for reminders, with CRON_SECRET. Run them by hand any time." right={<div className="hub-actions">
        <Button variant="default" size="sm" disabled={busy} onClick={() => void runJob("daily")}><Play size={13} /> Run daily checks</Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void runJob("dispatch")}><Play size={13} /> Run dispatcher</Button>
      </div>}>
        {d.jobs.length === 0 ? <Empty>No runs yet.</Empty> : d.jobs.slice(0, 6).map(j => <div key={j.id} className="hub-job">
          <div className="hub-recon-head"><b>{j.job === "daily" ? "Daily checks" : "Dispatcher"} · {when(j.at)}</b><Pill tone={j.ok ? "ok" : "bad"}>{j.ok ? "OK" : "Step failed"}</Pill><small>{j.trigger} · {j.durationMs} ms</small></div>
          <ul className="hub-list">{j.steps.map(s => <li key={s.name}><Pill tone={s.ok ? "ok" : "bad"}>{s.ok ? "✓" : "✗"}</Pill> <b>{s.name}</b> <small>{s.summary}</small></li>)}</ul>
        </div>)}
      </Card>
      <Card title="Ops channel" sub="Where alerts are posted." right={<span className="hub-modes">Slack <ModeBadge mode={d.modes["slack-alerts"]} /></span>}>
        {d.channel.length === 0 ? <Empty>{d.modes["slack-alerts"] === "live" ? "Messages go to your Slack channel." : "No messages yet (sandbox channel)."}</Empty> :
          <ul className="hub-chat">{d.channel.map((m, i) => <li key={i}><pre>{m.text}</pre><small>{when(m.at)}</small></li>)}</ul>}
      </Card>
    </div>

    <Card title="Runbooks" sub="What the ops team does for each kind of alert.">
      <div className="hub-runbooks">{Object.entries(d.runbooks).map(([id, rb]) => <details key={id}><summary>{rb.title}</summary><RunbookView rb={rb} /></details>)}</div>
    </Card>
  </div>;
}

function RunbookView({ rb }: { rb: Runbook }) {
  return <div className="hub-runbook"><small>When: {rb.when}</small><ol>{rb.steps.map((s, i) => <li key={i}>{s}</li>)}</ol></div>;
}
