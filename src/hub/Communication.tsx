import { useEffect, useState } from "react";
import { CalendarPlus, Download, Phone, Play, RefreshCw, Save, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, Empty, hubApi, ModeBadge, Msg, Pill, Stats, UrlRow, when } from "./shared";

type Message = { id: string; channel: "sms" | "email"; template: string; to: string; subject?: string; text: string; bookingRef?: string; status: string; error?: string; fallbackOf?: string; scheduledFor?: string; sentAt?: string; createdAt: string; providerId?: string };
type CallLog = { id: string; at: string; kind: string; fromMasked: string; toMasked: string; status: string; detail: string };
type Template = { subject: string; text: string };
type Settings = { templates: Record<string, Template>; ivr: { greeting: string; options: Array<{ digit: string; label: string; target: string }> } };
type Apt = { id: string; bookingId: string; patientName: string; scheduledAt?: string; status: string };

const TEMPLATE_TEXT: Record<string, string> = { booking_confirmation: "Booking confirmation", reminder: "Reminder", report_ready: "Report ready" };
const TONE: Record<string, "ok" | "bad" | "warn" | "info" | "muted"> = { delivered: "ok", sent: "info", scheduled: "muted", failed: "bad" };

export default function Communication() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [calls, setCalls] = useState<CallLog[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [appointments, setAppointments] = useState<Apt[]>([]);
  const [modes, setModes] = useState<Record<string, string>>({});
  const [urls, setUrls] = useState({ sms: "", ivr: "" });
  const [send, setSend] = useState({ channel: "sms", to: "", template: "booking_confirmation", name: "", bookingRef: "", when: "", tests: "", link: "", fallbackEmail: "" });
  const [call, setCall] = useState({ staffPhone: "", patientPhone: "", bookingRef: "" });
  const [digits, setDigits] = useState("1");
  const [ivrReply, setIvrReply] = useState("");
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = async () => {
    try {
      const d = await hubApi<{ messages: Message[]; calls: CallLog[]; settings: Settings; appointments: Apt[]; modes: Record<string, string>; callbackUrls: { sms: string; ivr: string } }>("/api/hub/comms");
      setMessages(d.messages); setCalls(d.calls); setSettings(s => s ?? d.settings); setAppointments(d.appointments); setModes(d.modes); setUrls(d.callbackUrls);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load."); }
  };
  useEffect(() => { void load(); }, []);
  const run = async (task: () => Promise<string>) => {
    setBusy(true); setError(""); setNotice("");
    try { setNotice(await task()); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Failed."); } finally { setBusy(false); }
  };

  const sendNow = () => run(async () => {
    const d = await hubApi<{ ok: boolean; message: Message }>("/api/hub/comms/send", { body: {
      channel: send.channel, to: send.to, template: send.template, bookingRef: send.bookingRef || undefined, fallbackEmail: send.channel === "sms" ? send.fallbackEmail : undefined,
      vars: { name: send.name, bookingRef: send.bookingRef, when: send.when, tests: send.tests, link: send.link }
    } });
    return d.ok ? `${send.channel === "sms" ? "SMS" : "Email"} accepted by the provider.` : `Not sent: ${d.message?.error ?? "provider error"}${send.fallbackEmail ? " (email fallback tried)" : ""}`;
  });
  const dispatch = () => run(async () => {
    const r = await hubApi<{ steps: Array<{ name: string; summary: string }> }>("/api/hub/comms/dispatch", { body: {} });
    return r.steps.map(s => `${s.name}: ${s.summary}`).join(" · ");
  });
  const deliveryReport = (m: Message, status: "delivered" | "failed") => run(async () => {
    await hubApi(`/api/hub/comms/messages/${m.id}/simulate-delivery`, { body: { status } });
    return `Provider reported "${status}".`;
  });
  const addCalendar = (a: Apt) => run(async () => {
    const r = await hubApi<{ ok: boolean; link?: string; error?: string }>(`/api/hub/appointments/${a.id}/calendar`, { body: {} });
    if (!r.ok) throw new Error(r.error ?? "Calendar error");
    return `Added to Google Calendar: ${r.link}`;
  });
  const connect = () => run(async () => {
    const r = await hubApi<{ ok: boolean; error?: string }>("/api/hub/comms/call", { body: call });
    if (!r.ok) throw new Error(r.error ?? "Call failed");
    return "Calling the staff phone first; the patient is connected when staff answers.";
  });
  const testIvr = async () => {
    try { const r = await hubApi<{ action: string; target?: string; say: string }>("/api/hub/comms/ivr-test", { body: { from: "9876543210", digits } }); setIvrReply(r.action === "route" ? `Routes to ${r.target}. Says: "${r.say}"` : `Repeats menu: "${r.say}"`); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed."); }
  };
  const saveSettings = () => run(async () => { await hubApi("/api/hub/comms/settings", { method: "PUT", body: settings }); return "Templates and IVR menu saved."; });

  const shown = messages.filter(m => filter === "all" || m.status === filter);
  const toOk = send.channel === "sms" ? send.to.replace(/\D/g, "").length >= 10 : /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(send.to);

  return <div className="hub-stack">
    <Msg error={error} notice={notice} />
    <Stats items={[
      ["Messages", messages.length],
      ["Delivered", messages.filter(m => m.status === "delivered").length],
      ["Scheduled", messages.filter(m => m.status === "scheduled").length],
      ["Failed", messages.filter(m => m.status === "failed").length, messages.some(m => m.status === "failed") ? "warn" : ""]
    ]} />

    <div className="hub-two">
      <Card title="Send a message" sub="SMS goes through Exotel, email through Gmail. A failed SMS falls back to email." right={<div className="hub-modes">Exotel <ModeBadge mode={modes.exotel} /> Gmail <ModeBadge mode={modes.gmail} /></div>}>
        <div className="hub-form">
          <label className="field"><span>Channel</span><select value={send.channel} onChange={e => setSend({ ...send, channel: e.target.value })}><option value="sms">SMS</option><option value="email">Email</option></select></label>
          <label className="field"><span>Template</span><select value={send.template} onChange={e => setSend({ ...send, template: e.target.value })}>{Object.keys(TEMPLATE_TEXT).map(t => <option key={t} value={t}>{TEMPLATE_TEXT[t]}</option>)}</select></label>
          <label className="field hub-wide"><span>{send.channel === "sms" ? "Mobile" : "Email"}</span><input value={send.to} onChange={e => setSend({ ...send, to: e.target.value })} placeholder={send.channel === "sms" ? "Ends in 0000 = DND in sandbox" : "name@example.com"} /></label>
          <label className="field"><span>Patient name</span><input value={send.name} onChange={e => setSend({ ...send, name: e.target.value })} /></label>
          <label className="field"><span>Booking ID</span><input value={send.bookingRef} onChange={e => setSend({ ...send, bookingRef: e.target.value })} /></label>
          <label className="field"><span>When</span><input value={send.when} onChange={e => setSend({ ...send, when: e.target.value })} placeholder="Tomorrow 8:00 AM" /></label>
          <label className="field"><span>Tests</span><input value={send.tests} onChange={e => setSend({ ...send, tests: e.target.value })} /></label>
          {send.template === "report_ready" && <label className="field hub-wide"><span>Report link</span><input value={send.link} onChange={e => setSend({ ...send, link: e.target.value })} /></label>}
          {send.channel === "sms" && <label className="field hub-wide"><span>Fallback email (optional)</span><input value={send.fallbackEmail} onChange={e => setSend({ ...send, fallbackEmail: e.target.value })} /></label>}
        </div>
        <div className="builder-actions"><Button variant="default" disabled={busy || !toOk} onClick={() => void sendNow()}><Send size={14} /> Send</Button></div>
      </Card>

      <Card title="Reminders and calendar" sub="Reminders go 24 h and 2 h before each scheduled booking. The dispatcher runs on a schedule; run it now to test.">
        <div className="builder-actions"><Button variant="outline" disabled={busy} onClick={() => void dispatch()}><Play size={14} /> Run reminder dispatcher</Button></div>
        {appointments.length === 0 ? <Empty>No bookings in the calendar.</Empty> : <ul className="hub-list hub-apts">{appointments.slice(0, 8).map(a => <li key={a.id}>
          <span><b>{a.patientName || "Patient"}</b> <code>{a.bookingId}</code><small>{a.scheduledAt ? when(a.scheduledAt) : "No time yet"}</small></span>
          <span className="hub-actions">
            <Button variant="outline" size="sm" disabled={busy || !a.scheduledAt} onClick={() => void addCalendar(a)}><CalendarPlus size={13} /> Google Calendar</Button>
            <a className="hub-link-btn" href={`/api/hub/appointments/${a.id}/ics`}><Download size={13} /> .ics</a>
          </span>
        </li>)}</ul>}
      </Card>
    </div>

    <Card title="Messages" sub="Delivery is tracked from the provider's status callback. In sandbox, act as the provider." right={<div className="hub-actions">
      <select value={filter} onChange={e => setFilter(e.target.value)} className="hub-select"><option value="all">All</option><option value="scheduled">Scheduled</option><option value="sent">Sent</option><option value="delivered">Delivered</option><option value="failed">Failed</option></select>
      <Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw size={13} /></Button>
    </div>}>
      {shown.length === 0 ? <Empty>No messages.</Empty> : <div className="hub-table-wrap"><table className="hub-table">
        <thead><tr><th>Created</th><th>Channel</th><th>To</th><th>Message</th><th>Status</th><th /></tr></thead>
        <tbody>{shown.map(m => <tr key={m.id}>
          <td>{when(m.createdAt)}{m.scheduledFor && m.status === "scheduled" && <small>due {when(m.scheduledFor)}</small>}</td>
          <td>{m.channel === "sms" ? "SMS" : "Email"}{m.fallbackOf && <small>fallback</small>}</td>
          <td>{m.to}</td>
          <td className="hub-text"><b>{TEMPLATE_TEXT[m.template] ?? m.template}</b><small>{m.text}</small></td>
          <td><Pill tone={TONE[m.status] ?? "muted"}>{m.status}</Pill>{m.error && <small className="hub-err">{m.error}</small>}</td>
          <td className="hub-actions">{m.status === "sent" && m.channel === "sms" && modes.exotel !== "live" && <>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void deliveryReport(m, "delivered")}>Delivered</Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void deliveryReport(m, "failed")}>Undelivered</Button>
          </>}</td>
        </tr>)}</tbody>
      </table></div>}
      <UrlRow label="Exotel SMS status callback" url={urls.sms} />
    </Card>

    <div className="hub-two">
      <Card title="Click-to-call" sub="Exotel rings the staff phone, then connects the patient. The patient never sees staff's personal number.">
        <div className="hub-form">
          <label className="field"><span>Staff phone</span><input value={call.staffPhone} onChange={e => setCall({ ...call, staffPhone: e.target.value })} /></label>
          <label className="field"><span>Patient phone</span><input value={call.patientPhone} onChange={e => setCall({ ...call, patientPhone: e.target.value })} /></label>
          <label className="field hub-wide"><span>Booking ID (optional)</span><input value={call.bookingRef} onChange={e => setCall({ ...call, bookingRef: e.target.value })} /></label>
        </div>
        <div className="builder-actions"><Button variant="default" disabled={busy || call.staffPhone.length < 10 || call.patientPhone.length < 10} onClick={() => void connect()}><Phone size={14} /> Connect call</Button></div>
        {calls.length > 0 && <ul className="hub-list">{calls.slice(0, 6).map(c => <li key={c.id}><Pill tone={c.status === "failed" ? "bad" : "info"}>{c.kind === "ivr" ? "IVR" : "Call"}</Pill> {c.fromMasked} → {c.toMasked} <small>{c.detail} · {when(c.at)}</small></li>)}</ul>}
      </Card>

      {settings && <Card title="IVR menu" sub="What a caller hears and where each key press goes. Exotel asks this endpoint for the route.">
        <label className="field"><span>Greeting</span><textarea rows={2} value={settings.ivr.greeting} onChange={e => setSettings({ ...settings, ivr: { ...settings.ivr, greeting: e.target.value } })} /></label>
        <div className="hub-ivr">{settings.ivr.options.map((o, i) => <div key={i}>
          <input value={o.digit} maxLength={1} onChange={e => { const options = [...settings.ivr.options]; options[i] = { ...o, digit: e.target.value }; setSettings({ ...settings, ivr: { ...settings.ivr, options } }); }} />
          <input value={o.label} onChange={e => { const options = [...settings.ivr.options]; options[i] = { ...o, label: e.target.value }; setSettings({ ...settings, ivr: { ...settings.ivr, options } }); }} />
          <input value={o.target} onChange={e => { const options = [...settings.ivr.options]; options[i] = { ...o, target: e.target.value }; setSettings({ ...settings, ivr: { ...settings.ivr, options } }); }} />
        </div>)}</div>
        <div className="hub-actions">
          <input className="hub-digit" value={digits} maxLength={1} onChange={e => setDigits(e.target.value)} aria-label="Key pressed" />
          <Button variant="outline" size="sm" onClick={() => void testIvr()}>Test key press</Button>
          <Button variant="default" size="sm" disabled={busy} onClick={() => void saveSettings()}><Save size={13} /> Save</Button>
        </div>
        {ivrReply && <p className="hub-note">{ivrReply}</p>}
        <UrlRow label="IVR routing endpoint for Exotel" url={urls.ivr} />
      </Card>}
    </div>

    {settings && <Card title="Message templates" sub="Placeholders: {name}, {bookingRef}, {when}, {tests}, {link}." right={<Button variant="default" size="sm" disabled={busy} onClick={() => void saveSettings()}><Save size={13} /> Save templates</Button>}>
      <div className="hub-templates">{Object.entries(settings.templates).map(([id, t]) => <div key={id}>
        <b>{TEMPLATE_TEXT[id] ?? id}</b>
        <label className="field"><span>Email subject</span><input value={t.subject} onChange={e => setSettings({ ...settings, templates: { ...settings.templates, [id]: { ...t, subject: e.target.value } } })} /></label>
        <label className="field"><span>Text</span><textarea rows={3} value={t.text} onChange={e => setSettings({ ...settings, templates: { ...settings.templates, [id]: { ...t, text: e.target.value } } })} /></label>
      </div>)}</div>
    </Card>}
  </div>;
}
