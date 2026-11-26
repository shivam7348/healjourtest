import { useEffect, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Clock, Play, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { call, when, type Run } from "./parts";

type JobRun = { id: string; at: string; trigger: string; ok: boolean; durationMs: number; steps: Array<{ name: string; ok: boolean; summary: string }> };
type Job = {
  id: string; name: string; description: string; schedule: string; cronUtc: string; enabled: boolean;
  changed: { at: string; by: string } | null; ranToday: boolean; nextRunAt: string | null; lastRun: JobRun | null; recentRuns: JobRun[];
};
type Data = { jobs: Job[]; onVercel: boolean; cronConfigured: boolean };

/** Every scheduled job: switch on/off, see when it runs next, run it now, read its last results. */
export function JobsTab({ run, onOpenHealthCheck }: { run: Run; onOpenHealthCheck: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = () => call<Data>("/api/super/jobs").then(setData).catch(() => undefined);
  useEffect(() => { void load(); }, []);
  if (!data) return <p className="sa-muted">Loading…</p>;

  const toggle = (j: Job) => {
    if (j.enabled && !window.confirm(`Switch off "${j.name}"? It will stop running on its own until you switch it on again.`)) return;
    void run(async () => { const d = await call<{ jobs: Job[] }>(`/api/super/jobs/${j.id}`, "PUT", { enabled: !j.enabled }); setData({ ...data, jobs: d.jobs }); return `"${j.name}" is now ${j.enabled ? "OFF" : "ON"}.`; });
  };
  const runNow = (j: Job) => {
    const extra = j.id === "healthcheck" ? " Test bookings go to every destination ticked in Daily health check." : j.id === "dispatch" ? " Due patient messages are sent now." : "";
    if (!window.confirm(`Run "${j.name}" now?${extra}`)) return;
    setBusy(j.id);
    void run(async () => {
      try {
        const d = await call<{ run: JobRun | null; jobs: Job[] }>(`/api/super/jobs/${j.id}/run`, "POST", {});
        setData({ ...data, jobs: d.jobs }); setOpen(j.id);
        return d.run ? (d.run.ok ? `"${j.name}" finished in ${(d.run.durationMs / 1000).toFixed(1)} s. All steps OK.` : `"${j.name}" finished with problems. See the steps below.`) : `"${j.name}" had nothing to do.`;
      } finally { setBusy(null); }
    });
  };

  return <div className="sa-stack">
    <section className="access-card">
      <div className="access-card-head"><div><h2>How jobs run</h2>
        <p>{data.onVercel
          ? data.cronConfigured ? "On Vercel: Vercel Cron calls each job at its time (vercel.json)." : "On Vercel, but CRON_SECRET is not set: Vercel Cron calls will be refused until you add it in the Vercel project settings."
          : "On this server: a built-in timer starts each job at its time (checked every minute). If the server was off at that time, the job still runs if it starts within 2 hours; otherwise that day is skipped."}
          {" "}Switched-off jobs never run on their own; "Run now" always works.</p></div></div>
    </section>
    {data.jobs.map(j => <section key={j.id} className={`access-card job-card${j.enabled ? "" : " off"}`}>
      <div className="job-head">
        <div className="job-title">
          <h2>{j.name}</h2>
          <p>{j.description}</p>
        </div>
        <button type="button" role="switch" aria-checked={j.enabled} aria-label={`${j.name} on or off`} className={`job-switch${j.enabled ? " on" : ""}`} onClick={() => toggle(j)}>
          <span /> {j.enabled ? "On" : "Off"}
        </button>
      </div>
      <div className="job-facts">
        <div><small>Schedule</small><b><Clock size={13} /> {j.schedule}</b></div>
        <div><small>Next run</small><b>{j.enabled ? when(j.nextRunAt ?? undefined) : "— (off)"}</b>{j.ranToday && <small>already ran today</small>}</div>
        <div><small>Last run</small>{j.lastRun ? <b className={j.lastRun.ok ? "job-ok" : "job-bad"}>{j.lastRun.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />} {when(j.lastRun.at)}</b> : <b>never</b>}{j.lastRun && <small>{j.lastRun.trigger}</small>}</div>
        <div className="job-actions">
          <Button variant="default" size="sm" disabled={busy !== null} onClick={() => runNow(j)}><Play size={13} /> {busy === j.id ? "Running…" : "Run now"}</Button>
          {j.id === "healthcheck" && <Button variant="outline" size="sm" onClick={onOpenHealthCheck}>Destinations…</Button>}
        </div>
      </div>
      {j.changed && <small className="sa-muted">Switched {j.enabled ? "on" : "off"} by {j.changed.by} · {when(j.changed.at)}</small>}
      {j.recentRuns.length > 0 && <div className="job-history">
        <button type="button" className="job-toggle" onClick={() => setOpen(open === j.id ? null : j.id)}>{open === j.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Recent runs ({j.recentRuns.length})</button>
        {open === j.id && j.recentRuns.map(r => <div key={r.id} className="hc-run">
          <div className="hc-run-head">{r.ok ? <CheckCircle2 size={15} className="hc-ok" /> : <XCircle size={15} className="hc-bad" />}<b>{when(r.at)}</b><small>{r.trigger} · {(r.durationMs / 1000).toFixed(1)} s</small></div>
          <ul>{r.steps.map((s, i) => <li key={i} className={s.ok ? "" : "bad"}><b>{s.name}</b> {s.summary}</li>)}</ul>
        </div>)}
      </div>}
    </section>)}
  </div>;
}
