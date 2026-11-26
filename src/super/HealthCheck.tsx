import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Play, Save, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { call, when, type Run } from "./parts";

type Settings = { enabled: boolean; perDestination: number; flabs: Array<{ connectionId: string; billing: boolean; booking: boolean }>; labIds: string[]; updatedAt?: string; updatedBy?: string };
type JobRun = { id: string; at: string; trigger: string; ok: boolean; durationMs: number; steps: Array<{ name: string; ok: boolean; summary: string }> };
type Data = { settings: Settings; runs: JobRun[]; hourIst: number; cronConfigured: boolean; onVercel: boolean; flabsAccounts: Array<{ id: string; label: string; phase: string; leadSource: string | null; billingReady: boolean }>; labs: Array<{ id: string; name: string; code: string; active: boolean }> };

/**
 * Daily booking health check: every day at 10:00 IST, test bookings go to the destinations ticked here
 * (test labs / test Flabs accounts only) and any failure raises an alert.
 */
export function HealthCheckTab({ run }: { run: Run }) {
  const [data, setData] = useState<Data | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [running, setRunning] = useState(false);
  const load = () => call<Data>("/api/super/healthcheck").then(d => { setData(d); setDraft(d.settings); }).catch(() => undefined);
  useEffect(() => { void load(); }, []);
  if (!data || !draft) return <p className="sa-muted">Loading…</p>;

  const flabsRow = (id: string) => draft.flabs.find(f => f.connectionId === id) ?? { connectionId: id, billing: false, booking: false };
  const setFlabs = (id: string, key: "billing" | "booking", on: boolean) => {
    const row = { ...flabsRow(id), [key]: on };
    setDraft({ ...draft, flabs: [...draft.flabs.filter(f => f.connectionId !== id), row] });
  };
  const toggleLab = (id: string) => setDraft({ ...draft, labIds: draft.labIds.includes(id) ? draft.labIds.filter(x => x !== id) : [...draft.labIds, id] });
  const destinations = draft.flabs.reduce((n, f) => n + Number(f.billing) + Number(f.booking), 0) + draft.labIds.length;
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.settings);

  const save = () => run(async () => { await call("/api/super/healthcheck", "PUT", draft); await load(); return `Saved. ${draft.enabled ? `Runs daily at ${data.hourIst}:00 IST to ${destinations} destination(s).` : "The daily run is off."}`; });
  const runNow = () => {
    if (!destinations) return void run(async () => "Tick at least one test destination first (and save).");
    if (!window.confirm(`Send ${draft.perDestination} test booking(s) to each of ${destinations} destination(s) now (${draft.perDestination * destinations} in total)? Flabs test bills stay in those Flabs accounts.`)) return;
    setRunning(true);
    void run(async () => {
      try { const d = await call<{ run: JobRun }>("/api/super/healthcheck/run", "POST", {}); await load(); return d.run.ok ? `All destinations passed (${Math.round(d.run.durationMs / 1000)} s).` : "Some destinations failed. See the run below (an alert was raised)."; }
      finally { setRunning(false); }
    });
  };

  return <div className="sa-stack">
    <section className="access-card">
      <div className="access-card-head"><div><h2>Daily booking health check</h2>
        <p>Every day at {data.hourIst}:00 IST, Healjour sends {draft.perDestination} clearly marked TEST booking(s) (patient "HEALJOUR TEST") to each destination ticked below and checks that every one is accepted. Any failure raises a critical alert.</p></div>
        <label className="sa-check hc-switch"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} /> {draft.enabled ? "On" : "Off"}</label></div>
      <div className="hc-warn"><AlertTriangle size={16} /><span><b>Tick only test labs and test Flabs accounts.</b> Lab Portal test cases are cancelled at once, but Flabs has no cancel API: test bills and leads stay in that Flabs account. Nothing is sent to anything left unticked.</span></div>
      <div className="hc-row">
        <label className="field"><span>Bookings per destination</span>
          <select value={draft.perDestination} onChange={e => setDraft({ ...draft, perDestination: Number(e.target.value) })}>{[1, 2, 3, 5, 10].map(n => <option key={n} value={n}>{n}</option>)}</select></label>
        <div className="hc-meta">
          <small>Schedule</small><b>Daily {data.hourIst}:00 IST</b>
          <small>{data.onVercel ? (data.cronConfigured ? "Vercel Cron (CRON_SECRET set)" : "Vercel Cron: set CRON_SECRET to enable") : "Built-in timer on this server"}</small>
        </div>
        <div className="hc-meta"><small>Ticked</small><b>{destinations} destination(s)</b><small>{draft.perDestination * destinations} test booking(s) per day</small></div>
      </div>

      <h3 className="hc-h">Flabs accounts</h3>
      {data.flabsAccounts.length === 0 ? <p className="sa-muted">No Flabs accounts connected.</p> : <div className="sa-table-wrap"><table className="sa-table">
        <thead><tr><th>Account</th><th>Billing (pre-booking)</th><th>Lead / booking</th></tr></thead>
        <tbody>{data.flabsAccounts.map(a => { const r = flabsRow(a.id); return <tr key={a.id}>
          <td><b>{a.label}</b><small>phase: {a.phase}</small></td>
          <td><label className="sa-check"><input type="checkbox" checked={r.billing} onChange={e => setFlabs(a.id, "billing", e.target.checked)} /> test</label>
            {a.billingReady ? <small className="sa-muted">lead source: {a.leadSource}</small>
              : <small className={`hc-need${r.billing ? " on" : ""}`}><AlertTriangle size={12} /> Needs a lead source: Orders &amp; Bookings → Pre-booking → Pre-booking setup</small>}</td>
          <td><label className="sa-check"><input type="checkbox" checked={r.booking} onChange={e => setFlabs(a.id, "booking", e.target.checked)} /> test</label></td>
        </tr>; })}</tbody>
      </table></div>}

      <h3 className="hc-h">Partner labs (Lab Portal)</h3>
      <div className="ws-choices">{data.labs.map(l => <label key={l.id} className={`ws-choice${draft.labIds.includes(l.id) ? " on" : ""}`}>
        <input type="checkbox" checked={draft.labIds.includes(l.id)} onChange={() => toggleLab(l.id)} /> {l.name} <small>{l.code}{!l.active && " · paused"}</small></label>)}</div>

      <div className="builder-actions hc-actions">
        <Button variant="default" disabled={!dirty} onClick={() => void save()}><Save size={14} /> Save</Button>
        <Button variant="outline" disabled={running || dirty} title={dirty ? "Save first" : undefined} onClick={runNow}><Play size={14} /> {running ? "Running…" : "Run now"}</Button>
        {data.settings.updatedBy && <small className="sa-muted">Last changed by {data.settings.updatedBy} · {when(data.settings.updatedAt)}</small>}
      </div>
    </section>

    <section className="access-card">
      <div className="access-card-head"><div><h2>Recent runs</h2><p>Each destination: how many were accepted and the average response time.</p></div></div>
      {data.runs.length === 0 ? <p className="sa-muted">No runs yet.</p> : data.runs.map(r => <div key={r.id} className="hc-run">
        <div className="hc-run-head">{r.ok ? <CheckCircle2 size={16} className="hc-ok" /> : <XCircle size={16} className="hc-bad" />}<b>{when(r.at)}</b><small>{r.trigger} · {Math.round(r.durationMs / 1000)} s</small></div>
        <ul>{r.steps.map((s, i) => <li key={i} className={s.ok ? "" : "bad"}><b>{s.name}</b> {s.summary}</li>)}</ul>
      </div>)}
    </section>
  </div>;
}
