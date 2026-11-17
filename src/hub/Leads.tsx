import { Fragment, useEffect, useState } from "react";
import { RefreshCw, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, Empty, hubApi, ModeBadge, Msg, Pill, rupees, Stats, UrlRow, when } from "./shared";

type Lead = {
  id: string; source: string; externalId?: string; campaign: string; adset?: string; ad?: string; name: string; phone: string; email: string;
  city?: string; interest?: string; status: "new" | "contacted" | "booked" | "lost"; bookingRef?: string;
  crm: { synced: boolean; id?: string; error?: string }; duplicates: number; receivedAt: string; history: Array<{ at: string; event: string; detail: string }>;
};
type Attribution = { source: string; campaign: string; leads: number; contacted: number; booked: number; lost: number; revenue: number; conversion: number };

const SOURCE_TEXT: Record<string, string> = { meta: "Meta Lead Ads", google: "Google Ads", justdial: "Justdial", practo: "Practo", website: "Website" };
const TONE: Record<string, "ok" | "bad" | "warn" | "info" | "muted"> = { new: "info", contacted: "warn", booked: "ok", lost: "muted" };

export default function Leads() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [attr, setAttr] = useState<Attribution[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [samples, setSamples] = useState<Record<string, unknown>>({});
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [modes, setModes] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState<string | null>(null);
  const [showSample, setShowSample] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = async () => {
    try {
      const d = await hubApi<{ leads: Lead[]; attribution: Attribution[]; sources: string[]; samples: Record<string, unknown>; webhookUrls: Record<string, string>; modes: Record<string, string> }>("/api/hub/leads");
      setLeads(d.leads); setAttr(d.attribution); setSources(d.sources); setSamples(d.samples); setUrls(d.webhookUrls); setModes(d.modes);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load."); }
  };
  useEffect(() => { void load(); }, []);
  const run = async (task: () => Promise<string>) => {
    setBusy(true); setError(""); setNotice("");
    try { setNotice(await task()); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Failed."); } finally { setBusy(false); }
  };
  const simulate = (source: string, repeat = false) => run(async () => {
    const r = await hubApi<{ saved: Array<{ duplicate: boolean }>; errors: string[] }>("/api/hub/leads/simulate", { body: { source, repeat } });
    if (r.errors.length) throw new Error(r.errors.join(" "));
    return r.saved[0]?.duplicate ? "Same phone within 7 days: the existing lead was updated, not duplicated." : `New ${SOURCE_TEXT[source]} lead received and pushed to the CRM.`;
  });
  const setStatus = (l: Lead, status: Lead["status"]) => run(async () => { await hubApi(`/api/hub/leads/${l.id}`, { method: "PATCH", body: { status } }); return `Lead marked ${status}.`; });
  const book = (l: Lead) => {
    const ref = window.prompt("Booking ID for this lead:", "HJ-");
    if (!ref || ref.trim().length < 3) return;
    void run(async () => { await hubApi(`/api/hub/leads/${l.id}`, { method: "PATCH", body: { bookingRef: ref.trim() } }); return "Lead linked to the booking."; });
  };

  const shown = leads.filter(l => filter === "all" || l.status === filter || l.source === filter);
  const booked = leads.filter(l => l.status === "booked").length;

  return <div className="hub-stack">
    <Msg error={error} notice={notice} />
    <Stats items={[
      ["Leads", leads.length],
      ["Waiting (new)", leads.filter(l => l.status === "new").length, leads.some(l => l.status === "new") ? "warn" : ""],
      ["Booked", booked],
      ["Conversion", leads.length ? `${Math.round((booked / leads.length) * 100)} %` : "—"]
    ]} />

    <Card title="Lead sources" sub="Each source posts to its own webhook URL. A phone seen again within 7 days updates the same lead. New leads go to LeadSquared." right={<div className="hub-modes">Meta <ModeBadge mode={modes["meta-graph"]} /> LeadSquared <ModeBadge mode={modes.leadsquared} /></div>}>
      <div className="hub-sources">{sources.map(s => <div key={s} className="hub-source">
        <b>{SOURCE_TEXT[s] ?? s}</b>
        <div className="hub-actions">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void simulate(s)}><Zap size={13} /> Send test lead</Button>
          {s === "justdial" && <Button variant="outline" size="sm" disabled={busy} onClick={() => void simulate(s, true)}>Send same lead again</Button>}
          <button type="button" className="hub-textbtn" onClick={() => setShowSample(showSample === s ? "" : s)}>{showSample === s ? "Hide payload" : "Payload"}</button>
        </div>
        {showSample === s && <pre className="hub-pre">{JSON.stringify(samples[s], null, 2)}</pre>}
        <UrlRow label="Webhook URL" url={urls[s] ?? ""} />
      </div>)}</div>
    </Card>

    <Card title="Campaign attribution" sub="Which source and campaign brought leads that booked, and the revenue paid on those bookings.">
      {attr.length === 0 ? <Empty>No leads yet.</Empty> : <div className="hub-table-wrap"><table className="hub-table">
        <thead><tr><th>Source</th><th>Campaign</th><th>Leads</th><th>Contacted</th><th>Booked</th><th>Lost</th><th>Conversion</th><th>Revenue</th></tr></thead>
        <tbody>{attr.map(a => <tr key={`${a.source}|${a.campaign}`}><td>{SOURCE_TEXT[a.source] ?? a.source}</td><td><code>{a.campaign}</code></td><td>{a.leads}</td><td>{a.contacted}</td><td>{a.booked}</td><td>{a.lost}</td><td><b>{a.conversion} %</b></td><td>{rupees(a.revenue)}</td></tr>)}</tbody>
      </table></div>}
    </Card>

    <Card title="Leads" sub="Enquiry to booking: a booking made for the same phone marks the lead booked automatically." right={<div className="hub-actions">
      <select className="hub-select" value={filter} onChange={e => setFilter(e.target.value)}>
        <option value="all">All</option><option value="new">New</option><option value="contacted">Contacted</option><option value="booked">Booked</option><option value="lost">Lost</option>
        {sources.map(s => <option key={s} value={s}>{SOURCE_TEXT[s]}</option>)}
      </select>
      <Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw size={13} /></Button>
    </div>}>
      {shown.length === 0 ? <Empty>No leads.</Empty> : <div className="hub-table-wrap"><table className="hub-table">
        <thead><tr><th>Received</th><th>Lead</th><th>Source / campaign</th><th>Interest</th><th>CRM</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>{shown.map(l => <Fragment key={l.id}>
          <tr className="hub-row" onClick={() => setOpen(open === l.id ? null : l.id)}>
            <td>{when(l.receivedAt)}{l.duplicates > 0 && <small>+{l.duplicates} repeat</small>}</td>
            <td><b>{l.name || "—"}</b><small>{l.phone}{l.city ? ` · ${l.city}` : ""}</small></td>
            <td>{SOURCE_TEXT[l.source] ?? l.source}<small>{l.campaign}</small></td>
            <td>{l.interest ?? "—"}</td>
            <td>{l.crm.synced ? <Pill tone="ok">Synced</Pill> : <Pill tone="bad">Not synced</Pill>}</td>
            <td><Pill tone={TONE[l.status]}>{l.status}</Pill>{l.bookingRef && <small>{l.bookingRef}</small>}</td>
            <td className="hub-actions" onClick={e => e.stopPropagation()}>
              {l.status === "new" && <Button variant="outline" size="sm" disabled={busy} onClick={() => void setStatus(l, "contacted")}>Contacted</Button>}
              {l.status !== "booked" && <Button variant="outline" size="sm" disabled={busy} onClick={() => book(l)}>Booked</Button>}
              {l.status !== "lost" && l.status !== "booked" && <Button variant="outline" size="sm" disabled={busy} onClick={() => void setStatus(l, "lost")}>Lost</Button>}
            </td>
          </tr>
          {open === l.id && <tr className="hub-detail"><td colSpan={7}><ol className="hub-timeline">{l.history.map((h, i) => <li key={i}><b>{h.event}</b> {h.detail}<small>{when(h.at)}</small></li>)}</ol></td></tr>}
        </Fragment>)}</tbody>
      </table></div>}
    </Card>
  </div>;
}
