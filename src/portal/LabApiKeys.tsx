import { useEffect, useState } from "react";
import { BookOpen, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type Hook = { id: string; url: string; events: string[]; lastStatus?: number | string; lastDeliveryAt?: string };
type LabApp = { id: string; clientId: string; name: string; active: boolean; createdAt: string; lastUsedAt?: string; revokedAt?: string; createdBy: { name: string }; webhooks: Hook[] };
type EventDoc = { name: string; description: string };

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) throw new Error(json?.error?.message ?? `Request failed (${res.status}).`);
  return json.data as T;
}
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "never");

/**
 * Lab Portal → API (lab admins only). API apps that let the lab's own software (LIS) receive this lab's
 * bookings and push status, results and reports. They can never see another lab.
 */
export function LabApiKeys() {
  const [apps, setApps] = useState<LabApp[]>([]);
  const [events, setEvents] = useState<EventDoc[]>([]);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<{ clientId: string; secret: string; label: string } | null>(null);
  const [hookFor, setHookFor] = useState<string | null>(null);
  const [hook, setHook] = useState<{ url: string; events: string[] }>({ url: "", events: ["booking.created"] });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => call<{ apps: LabApp[]; events: EventDoc[] }>("/api/portal/api-keys").then(d => { setApps(d.apps); setEvents(d.events); }).catch(e => setMsg({ ok: false, text: e.message }));
  useEffect(() => { void load(); }, []);
  const run = async (fn: () => Promise<string>) => { setMsg(null); try { setMsg({ ok: true, text: await fn() }); await load(); } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Failed." }); } };
  const copy = (t: string) => void navigator.clipboard?.writeText(t);

  return <section className="access-card">
    <div className="access-card-head"><div><h2>API access for your lab software</h2>
      <p>Connect your LIS: it receives this lab's bookings and sends back status, results and report files. These keys only ever see your own lab.</p></div>
      <a className="lab-api-docs" href="/developers" target="_blank" rel="noopener noreferrer"><BookOpen size={14} /> API docs</a></div>
    {msg && <div className={`access-message ${msg.ok ? "success" : "error"}`}>{msg.text}</div>}
    {secret && <div className="secret-box">
      <b>{secret.label}: copy the secret now. It will not be shown again.</b>
      <code>Client ID: {secret.clientId}</code><code>{secret.secret}</code>
      <div className="builder-actions"><Button variant="outline" size="sm" onClick={() => copy(secret.secret)}><Copy size={13} /> Copy secret</Button><Button variant="outline" size="sm" onClick={() => setSecret(null)}>I have saved it</Button></div>
    </div>}
    <div className="lab-api-new">
      <input value={name} onChange={e => setName(e.target.value)} placeholder="App name, e.g. Our LIS" aria-label="New API app name" />
      <Button variant="default" size="sm" disabled={name.trim().length < 2} onClick={() => void run(async () => {
        const d = await call<{ app: LabApp; clientSecret: string }>("/api/portal/api-keys", "POST", { name });
        setSecret({ clientId: d.app.clientId, secret: d.clientSecret, label: `"${d.app.name}" created` }); setName(""); return "API app created.";
      })}><Plus size={14} /> Create API app</Button>
    </div>
    {apps.length === 0 ? <p className="lab-api-empty">No API apps yet.</p> : apps.map(a => <div key={a.id} className={`lab-api-app${a.active ? "" : " off"}`}>
      <div className="lab-api-head">
        <b>{a.name}</b><span className={`access-status ${a.active ? "active" : "revoked"}`}>{a.active ? "active" : "revoked"}</span>
        <small>Client ID <code>{a.clientId}</code> <button type="button" className="corp-icon" aria-label="Copy Client ID" onClick={() => copy(a.clientId)}><Copy size={12} /></button></small>
        <small>by {a.createdBy.name} · {when(a.createdAt)} · last used {when(a.lastUsedAt)}</small>
        {a.active && <span className="lab-api-actions">
          <Button variant="outline" size="sm" onClick={() => { if (window.confirm("Create a new secret? The old one stops working at once.")) void run(async () => { const d = await call<{ clientSecret: string }>(`/api/portal/api-keys/${a.id}/rotate`, "POST", {}); setSecret({ clientId: a.clientId, secret: d.clientSecret, label: `New secret for "${a.name}"` }); return "Secret rotated."; }); }}><KeyRound size={13} /> Rotate</Button>
          <Button variant="destructive" size="sm" onClick={() => { if (window.confirm(`Revoke "${a.name}"? It stops working for good.`)) void run(async () => { await call(`/api/portal/api-keys/${a.id}`, "DELETE"); return "API app revoked."; }); }}>Revoke</Button>
        </span>}
      </div>
      {a.active && <div className="lab-api-hooks">
        <b>Webhooks</b>
        {a.webhooks.map(h => <div key={h.id} className="lab-api-hook"><code>{h.url}</code><small>{h.events.join(", ")} · last: {h.lastStatus ?? "—"}</small>
          <button type="button" className="corp-icon danger" aria-label="Delete webhook" onClick={() => void run(async () => { await call(`/api/portal/api-keys/${a.id}/webhooks/${h.id}`, "DELETE"); return "Webhook deleted."; })}><Trash2 size={12} /></button></div>)}
        {hookFor === a.id ? <div className="lab-api-hookform">
          <input value={hook.url} onChange={e => setHook({ ...hook, url: e.target.value })} placeholder="https://your-lis.example.com/healjour" aria-label="Webhook URL" />
          <div>{events.map(ev => <label key={ev.name} title={ev.description}><input type="checkbox" checked={hook.events.includes(ev.name)} onChange={() => setHook({ ...hook, events: hook.events.includes(ev.name) ? hook.events.filter(x => x !== ev.name) : [...hook.events, ev.name] })} /> {ev.name}</label>)}</div>
          <div className="builder-actions">
            <Button variant="default" size="sm" disabled={!hook.url || !hook.events.length} onClick={() => void run(async () => {
              const d = await call<{ webhook: { secret: string } }>(`/api/portal/api-keys/${a.id}/webhooks`, "POST", hook);
              setSecret({ clientId: a.clientId, secret: d.webhook.secret, label: "Webhook signing secret" }); setHookFor(null); setHook({ url: "", events: ["booking.created"] }); return "Webhook added.";
            })}>Add webhook</Button>
            <Button variant="outline" size="sm" onClick={() => setHookFor(null)}>Cancel</Button>
          </div>
        </div> : <Button variant="outline" size="sm" onClick={() => setHookFor(a.id)}><Plus size={13} /> Add webhook</Button>}
      </div>}
    </div>)}
  </section>;
}
