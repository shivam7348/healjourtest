"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Copy, KeyRound, LogOut, Plus, RefreshCw, Send, Trash2, Webhook as WebhookIcon } from "lucide-react";

type Account = { id: string; name: string; email: string; company: string };
type App = { id: string; clientId: string; name: string; description: string; kind: "partner" | "lab"; active: boolean; createdAt: string; rotatedAt?: string; lastUsedAt?: string; revokedAt?: string; webhooks: number };
type Hook = { id: string; url: string; events: string[]; active: boolean; createdAt: string; lastDeliveryAt?: string; lastStatus?: number | string };
type EventDoc = { name: string; description: string };
type ReqLog = { at: string; method: string; path: string; status: number; ms: number; requestId: string };
type Delivery = { id: string; event: string; attempt: number; at: string; status: number | string; ms: number; ok: boolean; error?: string };

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) {
    const details = Array.isArray(json?.error?.details) ? ` ${json.error.details.map((d: { field: string; message: string }) => `${d.field}: ${d.message}`).join("; ")}` : "";
    throw new Error((json?.error?.message ?? `Request failed (${res.status}).`) + details);
  }
  return json.data as T;
}
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" className="dv-btn sm" onClick={() => { void navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1200); }} aria-label="Copy">{done ? <Check size={13} /> : <Copy size={13} />}</button>;
}

function Auth({ onIn }: { onIn: (a: Account) => void }) {
  const [mode, setMode] = useState<"signup" | "login">("signup");
  const [f, setF] = useState({ name: "", email: "", company: "", password: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErr("");
    try {
      const d = await call<{ account: Account }>(`/api/developer/${mode}`, "POST", mode === "signup" ? f : { email: f.email, password: f.password });
      onIn(d.account);
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed."); } finally { setBusy(false); }
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return <div className="dv-page"><div className="dv-auth">
    <h1>{mode === "signup" ? "Create your developer account" : "Sign in"}</h1>
    <p className="dv-lead" style={{ fontSize: 14, marginBottom: 18 }}>{mode === "signup" ? "Free and instant. Create apps, get API keys and start building." : "Welcome back."}</p>
    <form onSubmit={e => { e.preventDefault(); void submit(); }}>
      {mode === "signup" && <>
        <label className="dv-field"><span>Your name</span><input value={f.name} onChange={set("name")} autoComplete="name" /></label>
        <label className="dv-field"><span>Company</span><input value={f.company} onChange={set("company")} autoComplete="organization" /></label>
      </>}
      <label className="dv-field"><span>Work email</span><input type="email" value={f.email} onChange={set("email")} autoComplete="email" /></label>
      <label className="dv-field"><span>Password</span><input type="password" value={f.password} onChange={set("password")} autoComplete={mode === "signup" ? "new-password" : "current-password"} />
        {mode === "signup" && <small style={{ color: "var(--dv-text3)", fontSize: 12 }}>At least 10 characters, with letters and a digit.</small>}</label>
      {err && <div className="dv-msg err">{err}</div>}
      <button type="submit" className="dv-btn primary" style={{ width: "100%", justifyContent: "center" }} disabled={busy}>{busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}</button>
    </form>
    <div className="dv-switch">{mode === "signup" ? <>Already have an account? <button type="button" onClick={() => setMode("login")}>Sign in</button></> : <>New here? <button type="button" onClick={() => setMode("signup")}>Create an account</button></>}</div>
  </div></div>;
}

function Secret({ clientId, secret, onDone }: { clientId: string; secret: string; onDone: () => void }) {
  return <div className="dv-secret">
    <b>Copy your Client Secret now. It will not be shown again.</b>
    <dl className="dv-kv"><dt>Client ID</dt><dd><code>{clientId}</code><CopyBtn text={clientId} /></dd><dt>Client Secret</dt><dd><code>{secret}</code><CopyBtn text={secret} /></dd></dl>
    <p style={{ fontSize: 13, margin: "0 0 10px" }}>Keep it on your server only. Next: <Link href="/developers/auth-token">get an access token</Link>.</p>
    <button type="button" className="dv-btn sm" onClick={onDone}>I have saved it</button>
  </div>;
}

function Webhooks({ app }: { app: App }) {
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [events, setEvents] = useState<EventDoc[]>([]);
  const [url, setUrl] = useState("");
  const [pick, setPick] = useState<string[]>(["booking.status_changed", "booking.report_uploaded"]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [newSecret, setNewSecret] = useState("");
  const load = () => call<{ webhooks: Hook[]; events: EventDoc[] }>(`/api/developer/apps/${app.id}/webhooks`).then(d => { setHooks(d.webhooks); setEvents(d.events); }).catch(() => undefined);
  useEffect(() => { void load(); }, [app.id]);
  const act = async (fn: () => Promise<string>) => { setMsg(null); try { setMsg({ ok: true, text: await fn() }); await load(); } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : "Failed." }); } };
  return <div>
    {msg && <div className={`dv-msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</div>}
    {newSecret && <div className="dv-secret"><b>Signing secret, shown once:</b><code>{newSecret}</code><CopyBtn text={newSecret} /> <button type="button" className="dv-btn sm" onClick={() => setNewSecret("")}>Done</button>
      <p style={{ fontSize: 13, margin: "8px 0 0" }}>Use it to verify X-Healjour-Signature. <Link href="/developers/webhooks">How to verify</Link></p></div>}
    {app.active && <div className="dv-panel" style={{ background: "var(--dv-bg2)" }}>
      <label className="dv-field"><span>Endpoint URL (https)</span><input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://your-server.com/healjour/webhooks" /></label>
      <div className="dv-checks">{events.map(ev => <label key={ev.name}><input type="checkbox" checked={pick.includes(ev.name)} onChange={() => setPick(pick.includes(ev.name) ? pick.filter(x => x !== ev.name) : [...pick, ev.name])} /><span><b>{ev.name}</b> {ev.description}</span></label>)}</div>
      <button type="button" className="dv-btn primary sm" disabled={!url || !pick.length} onClick={() => void act(async () => {
        const d = await call<{ webhook: Hook & { secret: string } }>(`/api/developer/apps/${app.id}/webhooks`, "POST", { url, events: pick });
        setNewSecret(d.webhook.secret); setUrl(""); return "Webhook added.";
      })}><Plus size={13} /> Add webhook</button>
    </div>}
    {hooks.length === 0 ? <p style={{ fontSize: 13.5 }}>No webhooks yet.</p> : <table className="dv-log"><thead><tr><th>URL</th><th>Events</th><th>Last delivery</th><th /></tr></thead><tbody>
      {hooks.map(h => <tr key={h.id}><td style={{ whiteSpace: "normal", wordBreak: "break-all" }}><code>{h.url}</code></td><td style={{ whiteSpace: "normal" }}>{h.events.join(", ")}</td>
        <td>{h.lastDeliveryAt ? <span className={`dv-status ${typeof h.lastStatus === "number" && h.lastStatus < 300 ? "ok" : "err"}`}>{h.lastStatus}</span> : "—"} {when(h.lastDeliveryAt)}</td>
        <td style={{ display: "flex", gap: 6 }}>
          <button type="button" className="dv-btn sm" onClick={() => void act(async () => { const d = await call<{ delivery: Delivery }>(`/api/developer/apps/${app.id}/webhooks/${h.id}/test`, "POST", {}); return d.delivery.ok ? `Test delivered: HTTP ${d.delivery.status} in ${d.delivery.ms} ms.` : `Test failed: ${d.delivery.error ?? d.delivery.status}.`; })}><Send size={12} /> Send test</button>
          <button type="button" className="dv-btn sm danger" aria-label="Delete webhook" onClick={() => { if (window.confirm("Delete this webhook?")) void act(async () => { await call(`/api/developer/apps/${app.id}/webhooks/${h.id}`, "DELETE"); return "Webhook deleted."; }); }}><Trash2 size={12} /></button>
        </td></tr>)}
    </tbody></table>}
  </div>;
}

function Activity({ app }: { app: App }) {
  const [d, setD] = useState<{ requests: ReqLog[]; deliveries: Delivery[] } | null>(null);
  const load = () => call<{ requests: ReqLog[]; deliveries: Delivery[] }>(`/api/developer/apps/${app.id}/activity`).then(setD).catch(() => undefined);
  useEffect(() => { void load(); }, [app.id]);
  if (!d) return <p>Loading…</p>;
  return <div>
    <button type="button" className="dv-btn sm" onClick={() => void load()}><RefreshCw size={12} /> Refresh</button>
    <h3>Recent API requests</h3>
    {d.requests.length === 0 ? <p style={{ fontSize: 13.5 }}>No requests yet.</p> : <div style={{ overflow: "auto" }}><table className="dv-log"><thead><tr><th>Time</th><th>Request</th><th>Status</th><th>ms</th><th>Request ID</th></tr></thead><tbody>
      {d.requests.map(r => <tr key={r.requestId}><td>{when(r.at)}</td><td><span className={`dv-method ${r.method}`}>{r.method}</span> {r.path}</td><td><span className={`dv-status ${r.status < 400 ? "ok" : "err"}`}>{r.status}</span></td><td>{r.ms}</td><td><code>{r.requestId}</code></td></tr>)}
    </tbody></table></div>}
    <h3>Webhook deliveries</h3>
    {d.deliveries.length === 0 ? <p style={{ fontSize: 13.5 }}>No deliveries yet.</p> : <div style={{ overflow: "auto" }}><table className="dv-log"><thead><tr><th>Time</th><th>Event</th><th>Attempt</th><th>Result</th><th>ms</th></tr></thead><tbody>
      {d.deliveries.map(x => <tr key={x.id}><td>{when(x.at)}</td><td>{x.event}</td><td>{x.attempt}</td><td><span className={`dv-status ${x.ok ? "ok" : "err"}`}>{x.status}</span>{x.error && ` ${x.error}`}</td><td>{x.ms}</td></tr>)}
    </tbody></table></div>}
    <p style={{ fontSize: 12.5, color: "var(--dv-text3)" }}>Requests are kept for the last 100 calls per server; deliveries are stored.</p>
  </div>;
}

function AppCard({ app, onChanged }: { app: App; onChanged: () => void }) {
  const [tab, setTab] = useState<"keys" | "webhooks" | "activity">("keys");
  const [secret, setSecret] = useState("");
  const [err, setErr] = useState("");
  const rotate = async () => {
    if (!window.confirm("Create a new Client Secret? The old secret and every token from it stop working immediately.")) return;
    try { const d = await call<{ clientSecret: string }>(`/api/developer/apps/${app.id}/rotate`, "POST", {}); setSecret(d.clientSecret); onChanged(); } catch (e) { setErr(e instanceof Error ? e.message : "Failed."); }
  };
  const revoke = async () => {
    if (!window.confirm(`Revoke "${app.name}"? Its keys and tokens stop working for good. This cannot be undone.`)) return;
    try { await call(`/api/developer/apps/${app.id}`, "DELETE"); onChanged(); } catch (e) { setErr(e instanceof Error ? e.message : "Failed."); }
  };
  return <div className={`dv-app${app.active ? "" : " off"}`}>
    <div className="dv-app-head">
      <b>{app.name}</b><span className={`dv-badge ${app.kind}`}>{app.kind === "partner" ? "Partner app" : "Lab app"}</span>
      <span className={`dv-status ${app.active ? "ok" : "err"}`}>{app.active ? "Active" : `Revoked ${when(app.revokedAt)}`}</span>
      {app.active && <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
        <button type="button" className="dv-btn sm" onClick={() => void rotate()}><KeyRound size={12} /> Rotate secret</button>
        <button type="button" className="dv-btn sm danger" onClick={() => void revoke()}>Revoke</button>
      </span>}
    </div>
    {app.description && <p style={{ fontSize: 13.5, margin: "6px 0 0" }}>{app.description}</p>}
    {err && <div className="dv-msg err">{err}</div>}
    {secret && <Secret clientId={app.clientId} secret={secret} onDone={() => setSecret("")} />}
    <div className="dv-subtabs">
      <button type="button" className={tab === "keys" ? "on" : ""} onClick={() => setTab("keys")}>Keys</button>
      <button type="button" className={tab === "webhooks" ? "on" : ""} onClick={() => setTab("webhooks")}><WebhookIcon size={12} style={{ verticalAlign: -1 }} /> Webhooks ({app.webhooks})</button>
      <button type="button" className={tab === "activity" ? "on" : ""} onClick={() => setTab("activity")}>Activity</button>
    </div>
    {tab === "keys" && <dl className="dv-kv">
      <dt>Client ID</dt><dd><code>{app.clientId}</code><CopyBtn text={app.clientId} /></dd>
      <dt>Client Secret</dt><dd>•••••••• (shown once when created or rotated)</dd>
      <dt>Created</dt><dd>{when(app.createdAt)}{app.rotatedAt && ` · rotated ${when(app.rotatedAt)}`}</dd>
      <dt>Last used</dt><dd>{when(app.lastUsedAt)}</dd>
    </dl>}
    {tab === "webhooks" && <Webhooks app={app} />}
    {tab === "activity" && <Activity app={app} />}
  </div>;
}

export function DevConsole() {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [apps, setApps] = useState<App[]>([]);
  const [creating, setCreating] = useState<{ name: string; description: string } | null>(null);
  const [fresh, setFresh] = useState<{ clientId: string; secret: string } | null>(null);
  const [err, setErr] = useState("");
  const loadApps = () => call<{ apps: App[] }>("/api/developer/apps").then(d => setApps(d.apps)).catch(() => undefined);
  useEffect(() => { void call<{ account: Account | null }>("/api/developer/me").then(d => { setAccount(d.account); if (d.account) void loadApps(); }).catch(() => setAccount(null)); }, []);

  if (account === undefined) return <p>Loading…</p>;
  if (!account) return <Auth onIn={a => { setAccount(a); void loadApps(); }} />;

  const create = async () => {
    if (!creating) return;
    setErr("");
    try {
      const d = await call<{ app: App; clientSecret: string }>("/api/developer/apps", "POST", creating);
      setFresh({ clientId: d.app.clientId, secret: d.clientSecret }); setCreating(null); await loadApps();
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed."); }
  };
  const active = apps.filter(a => a.active), revoked = apps.filter(a => !a.active);
  return <div className="dv-page wide" style={{ maxWidth: 980 }}>
    <div className="dv-eyebrow">Developer console</div>
    <h1>Hi {account.name.split(" ")[0]} 👋</h1>
    <p className="dv-lead">{account.company} · {account.email} <button type="button" className="dv-btn sm" style={{ marginLeft: 8 }} onClick={() => void call("/api/developer/logout", "POST", {}).then(() => { setAccount(null); setApps([]); })}><LogOut size={12} /> Sign out</button></p>

    <div className="dv-panel">
      <div className="dv-panel-head"><div><h2>Your apps</h2><p>Each app has its own keys, webhooks and logs. Partner apps create bookings and see only their own bookings.</p></div>
        {!creating && <button type="button" className="dv-btn primary" onClick={() => setCreating({ name: "", description: "" })}><Plus size={14} /> New app</button>}</div>
      {creating && <div className="dv-panel" style={{ background: "var(--dv-bg2)" }}>
        <label className="dv-field"><span>App name</span><input value={creating.name} onChange={e => setCreating({ ...creating, name: e.target.value })} placeholder="e.g. Clinic booking app" /></label>
        <label className="dv-field"><span>What it does (optional)</span><input value={creating.description} onChange={e => setCreating({ ...creating, description: e.target.value })} /></label>
        {err && <div className="dv-msg err">{err}</div>}
        <div style={{ display: "flex", gap: 8 }}><button type="button" className="dv-btn primary" disabled={creating.name.trim().length < 2} onClick={() => void create()}>Create app</button><button type="button" className="dv-btn" onClick={() => setCreating(null)}>Cancel</button></div>
      </div>}
      {fresh && <Secret clientId={fresh.clientId} secret={fresh.secret} onDone={() => setFresh(null)} />}
      {active.length === 0 && !creating && <p style={{ fontSize: 14 }}>No apps yet. Create one to get your Client ID and Secret, then follow the <Link href="/developers/quickstart">Quickstart</Link>.</p>}
      {active.map(a => <AppCard key={a.id} app={a} onChanged={() => void loadApps()} />)}
      {revoked.length > 0 && <details style={{ marginTop: 14 }}><summary style={{ cursor: "pointer", fontSize: 13.5, color: "var(--dv-text3)" }}>Revoked apps ({revoked.length})</summary>{revoked.map(a => <AppCard key={a.id} app={a} onChanged={() => void loadApps()} />)}</details>}
    </div>

    <div className="dv-panel">
      <div className="dv-panel-head"><div><h2>Are you a lab?</h2><p>Lab apps (to receive your lab's bookings and push results) are created by your lab admin in the Healjour Lab Portal → API. They only ever see your own lab.</p></div></div>
    </div>
  </div>;
}
