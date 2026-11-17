import { useEffect, useState } from "react";
import { BookOpen, Plus, RefreshCw, Send, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, Empty, hubApi, Msg, Pill, Stats, UrlRow, when } from "./shared";

type App = {
  id: string; name: string; developer: string; developerEmail: string; category: string; description: string; privacyPolicyUrl: string;
  redirectUri: string; webhookUrl: string; scopes: string[]; status: string; version: number; clientId: string;
  review?: { notes: string; by: string; at: string; decision: string }; history: Array<{ at: string; event: string; detail: string }>;
};
type Installation = { id: string; appId: string; labId: string; labName: string; scopes: string[]; status: string; installedBy: string; at: string };
type Data = { apps: App[]; installations: Installation[]; scopes: Record<string, string>; checks: Record<string, string>; labs: Array<{ id: string; name: string }>; inbox: Array<{ at: string; app: string; event: string; signature: string }>; endpoints: Record<string, string> };

const TONE: Record<string, "ok" | "bad" | "warn" | "info" | "muted"> = { draft: "muted", in_review: "info", approved: "ok", rejected: "bad", suspended: "bad" };
const EMPTY_APP = { name: "", developer: "", developerEmail: "", category: "AI imaging", description: "", privacyPolicyUrl: "https://", redirectUri: "sandbox", webhookUrl: "sandbox", scopes: ["cases:read"] as string[] };

export default function AppStore() {
  const [d, setD] = useState<Data | null>(null);
  const [form, setForm] = useState(EMPTY_APP);
  const [secrets, setSecrets] = useState<{ clientId: string; clientSecret: string; webhookSecret: string } | null>(null);
  const [reviewing, setReviewing] = useState<{ id: string; checks: Record<string, boolean>; notes: string } | null>(null);
  const [installing, setInstalling] = useState<{ appId: string; labId: string; scopes: string[] } | null>(null);
  const [code, setCode] = useState<{ code: string; redirect: string | null } | null>(null);
  const [showDocs, setShowDocs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = async () => { try { setD(await hubApi<Data>("/api/hub/apps")); } catch (e) { setError(e instanceof Error ? e.message : "Could not load."); } };
  useEffect(() => { void load(); }, []);
  const run = async (task: () => Promise<string>) => {
    setBusy(true); setError(""); setNotice("");
    try { setNotice(await task()); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Failed."); } finally { setBusy(false); }
  };
  if (!d) return <Msg error={error} />;

  const create = () => run(async () => {
    const r = await hubApi<{ app: App; clientSecret: string; webhookSecret: string }>("/api/hub/apps", { body: form });
    setSecrets({ clientId: r.app.clientId, clientSecret: r.clientSecret, webhookSecret: r.webhookSecret });
    setForm(EMPTY_APP);
    return `"${r.app.name}" registered as a draft. Copy its secrets now; they are not shown again.`;
  });
  const submit = (a: App) => run(async () => { await hubApi(`/api/hub/apps/${a.id}/submit`, { body: {} }); return `${a.name} sent for review.`; });
  const decide = (decision: "approved" | "rejected") => reviewing && run(async () => {
    await hubApi(`/api/hub/apps/${reviewing.id}/review`, { body: { decision, checks: reviewing.checks, notes: reviewing.notes } });
    setReviewing(null);
    return decision === "approved" ? "App approved: centres can now install it." : "App rejected; the developer sees your notes.";
  });
  const install = () => installing && run(async () => {
    const r = await hubApi<{ code: string; redirect: string | null }>(`/api/hub/apps/${installing.appId}/install`, { body: { labId: installing.labId, scopes: installing.scopes } });
    setCode(r); setInstalling(null);
    return "Installed. The app now exchanges the code for tokens.";
  });
  const suspend = (a: App, suspended: boolean) => run(async () => { await hubApi(`/api/hub/apps/${a.id}/suspend`, { body: { suspended } }); return suspended ? "App suspended: its tokens stop working." : "App reinstated."; });
  const revoke = (i: Installation) => run(async () => { await hubApi(`/api/hub/installations/${i.id}/revoke`, { body: {} }); return "Installation revoked: the app lost access to this centre."; });
  const testEvent = (i: Installation) => run(async () => {
    const r = await hubApi<{ ok: boolean; error?: string }>(`/api/hub/installations/${i.id}/test-event`, { body: {} });
    if (!r.ok) throw new Error(r.error ?? "Not delivered");
    return "Signed event delivered to the app.";
  });

  const appName = (id: string) => d.apps.find(a => a.id === id)?.name ?? id;
  const formOk = form.name.trim().length >= 3 && form.developer.trim().length >= 2 && /@/.test(form.developerEmail) && form.description.trim().length >= 10 && form.scopes.length > 0;

  return <div className="hub-stack">
    <Msg error={error} notice={notice} />
    <Stats items={[["Apps", d.apps.length], ["In review", d.apps.filter(a => a.status === "in_review").length, d.apps.some(a => a.status === "in_review") ? "warn" : ""], ["Approved", d.apps.filter(a => a.status === "approved").length], ["Active installs", d.installations.filter(i => i.status === "active").length]]} />

    {secrets && <div className="secret-box">
      <b>Credentials for the developer (shown once)</b>
      <code>client_id: {secrets.clientId}</code><code>client_secret: {secrets.clientSecret}</code><code>webhook signing secret: {secrets.webhookSecret}</code>
      <small>Send these to the developer privately. Healjour stores only a hash of the client secret.</small>
      <div className="builder-actions"><Button variant="outline" size="sm" onClick={() => setSecrets(null)}>Done</Button></div>
    </div>}
    {code && <div className="secret-box">
      <b>Authorization code (valid 10 minutes, one use)</b>
      <code>{code.code}</code>
      <small>{code.redirect ? `Sent to the app at ${code.redirect.split("?")[0]}.` : "Sandbox app: give this code to the developer to exchange at the token endpoint."}</small>
      <div className="builder-actions"><Button variant="outline" size="sm" onClick={() => setCode(null)}>Done</Button></div>
    </div>}

    <Card title="Developer platform" sub="How third-party apps connect to a centre." right={<Button variant="outline" size="sm" onClick={() => setShowDocs(!showDocs)}><BookOpen size={13} /> {showDocs ? "Hide" : "Show"} developer docs</Button>}>
      <UrlRow label="Token endpoint (OAuth 2.0)" url={d.endpoints.token} />
      <UrlRow label="List cases (scope cases:read)" url={d.endpoints.cases} />
      <UrlRow label="Case results (scope results:read)" url={d.endpoints.results} />
      {showDocs && <DevDocs scopes={d.scopes} />}
    </Card>

    <Card title="Register an app" sub="Developers start in the Sandbox Lab with synthetic data. Real centres can install an app only after review.">
      <div className="hub-form">
        <label className="field"><span>App name</span><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
        <label className="field"><span>Category</span><input value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} /></label>
        <label className="field"><span>Developer / company</span><input value={form.developer} onChange={e => setForm({ ...form, developer: e.target.value })} /></label>
        <label className="field"><span>Developer email</span><input value={form.developerEmail} onChange={e => setForm({ ...form, developerEmail: e.target.value })} /></label>
        <label className="field hub-wide"><span>What it does</span><textarea rows={2} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></label>
        <label className="field"><span>Privacy policy URL</span><input value={form.privacyPolicyUrl} onChange={e => setForm({ ...form, privacyPolicyUrl: e.target.value })} /></label>
        <label className="field"><span>Redirect URI</span><input value={form.redirectUri} onChange={e => setForm({ ...form, redirectUri: e.target.value })} /><small>"sandbox" or a public https URL</small></label>
        <label className="field"><span>Webhook URL</span><input value={form.webhookUrl} onChange={e => setForm({ ...form, webhookUrl: e.target.value })} /><small>"sandbox" or a public https URL</small></label>
        <div className="field hub-wide"><span>Scopes requested</span><div className="hub-checks">{Object.entries(d.scopes).map(([s, text]) => <label key={s}><input type="checkbox" checked={form.scopes.includes(s)} onChange={e => setForm({ ...form, scopes: e.target.checked ? [...form.scopes, s] : form.scopes.filter(x => x !== s) })} /> <code>{s}</code> {text}</label>)}</div></div>
      </div>
      <div className="builder-actions"><Button variant="default" disabled={busy || !formOk} onClick={() => void create()}><Plus size={14} /> Register app</Button></div>
    </Card>

    <Card title="Apps" right={<Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw size={13} /></Button>}>
      {d.apps.length === 0 ? <Empty>No apps yet.</Empty> : <div className="hub-apps">{d.apps.map(a => <div key={a.id} className="hub-app">
        <div className="hub-app-head"><div><b>{a.name}</b><small>{a.developer} · {a.category} · v{a.version}</small></div><Pill tone={TONE[a.status] ?? "muted"}>{a.status.replace("_", " ")}</Pill></div>
        <p>{a.description}</p>
        <div className="hub-chips">{a.scopes.map(s => <span key={s}><code>{s}</code></span>)}</div>
        {a.review && <small className="hub-note">Review by {a.review.by} on {when(a.review.at)}{a.review.notes ? `: ${a.review.notes}` : ""}</small>}
        <div className="hub-actions">
          {(a.status === "draft" || a.status === "rejected") && <Button variant="outline" size="sm" disabled={busy} onClick={() => void submit(a)}><Send size={13} /> Submit for review</Button>}
          {a.status === "in_review" && <Button variant="default" size="sm" onClick={() => setReviewing({ id: a.id, checks: {}, notes: "" })}><ShieldCheck size={13} /> Review</Button>}
          {a.status !== "rejected" && a.status !== "suspended" && <Button variant="outline" size="sm" onClick={() => setInstalling({ appId: a.id, labId: "sandbox-lab", scopes: [...a.scopes] })}>Install in a centre</Button>}
          {a.status === "approved" && <Button variant="destructive" size="sm" disabled={busy} onClick={() => void suspend(a, true)}>Suspend</Button>}
          {a.status === "suspended" && <Button variant="outline" size="sm" disabled={busy} onClick={() => void suspend(a, false)}>Reinstate</Button>}
        </div>
        {reviewing?.id === a.id && <div className="hub-review">
          <b>App review checklist</b>
          {Object.entries(d.checks).map(([k, text]) => <label key={k}><input type="checkbox" checked={Boolean(reviewing.checks[k])} onChange={e => setReviewing({ ...reviewing, checks: { ...reviewing.checks, [k]: e.target.checked } })} /> {text}</label>)}
          <label className="field"><span>Notes for the developer</span><textarea rows={2} value={reviewing.notes} onChange={e => setReviewing({ ...reviewing, notes: e.target.value })} /></label>
          <div className="hub-actions">
            <Button variant="default" size="sm" disabled={busy} onClick={() => void decide("approved")}>Approve</Button>
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => void decide("rejected")}>Reject</Button>
            <Button variant="outline" size="sm" onClick={() => setReviewing(null)}>Cancel</Button>
          </div>
        </div>}
        {installing?.appId === a.id && <div className="hub-review">
          <b>Install {a.name}: the centre grants access</b>
          <label className="field"><span>Centre</span><select value={installing.labId} onChange={e => setInstalling({ ...installing, labId: e.target.value })}>{d.labs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
          {a.status !== "approved" && installing.labId !== "sandbox-lab" && <small className="hub-err">Not approved yet: only the Sandbox Lab is allowed.</small>}
          {a.scopes.map(s => <label key={s}><input type="checkbox" checked={installing.scopes.includes(s)} onChange={e => setInstalling({ ...installing, scopes: e.target.checked ? [...installing.scopes, s] : installing.scopes.filter(x => x !== s) })} /> <code>{s}</code> {d.scopes[s]}</label>)}
          <div className="hub-actions">
            <Button variant="default" size="sm" disabled={busy || installing.scopes.length === 0} onClick={() => void install()}>Allow and install</Button>
            <Button variant="outline" size="sm" onClick={() => setInstalling(null)}>Cancel</Button>
          </div>
        </div>}
      </div>)}</div>}
    </Card>

    <div className="hub-two">
      <Card title="Installations" sub="Each installation sees only its centre's data, and only the granted scopes.">
        {d.installations.length === 0 ? <Empty>No installations.</Empty> : <ul className="hub-list">{d.installations.map(i => <li key={i.id}>
          <span><b>{appName(i.appId)}</b> in {i.labName} <Pill tone={i.status === "active" ? "ok" : "muted"}>{i.status}</Pill><small>{i.scopes.join(", ")} · {when(i.at)}</small></span>
          {i.status === "active" && <span className="hub-actions">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void testEvent(i)}>Send test event</Button>
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => void revoke(i)}>Revoke</Button>
          </span>}
        </li>)}</ul>}
      </Card>
      <Card title="Sandbox app inbox" sub="Signed webhook events received by sandbox apps.">
        {d.inbox.length === 0 ? <Empty>Nothing received yet.</Empty> : <ul className="hub-list">{d.inbox.map((m, i) => <li key={i}><b>{m.event}</b> → {appName(m.app)}<small>{when(m.at)} · {m.signature.slice(0, 22)}…</small></li>)}</ul>}
      </Card>
    </div>
  </div>;
}

function DevDocs({ scopes }: { scopes: Record<string, string> }) {
  return <div className="hub-docs">
    <h3>1. Register and test in the sandbox</h3>
    <p>Register the app here. You get a <code>client_id</code>, a <code>client_secret</code> and a webhook signing secret. Until review passes, the app can only be installed in the <b>Sandbox Lab</b>, which returns synthetic cases.</p>
    <h3>2. Installation and authorization code</h3>
    <p>A centre admin installs the app and ticks the scopes it allows. Healjour redirects to your <code>redirect_uri</code> with <code>?code=…</code> (valid 10 minutes, one use).</p>
    <h3>3. Exchange the code for tokens</h3>
    <pre className="hub-pre">{`POST /api/appstore/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=CODE&client_id=ID&client_secret=SECRET&redirect_uri=URI

→ { "access_token": "hjt_…", "expires_in": 3600, "refresh_token": "hjr_…", "scope": "cases:read" }`}</pre>
    <p>Access tokens last 1 hour. Use <code>grant_type=refresh_token</code> to get a new pair; each refresh token works once.</p>
    <h3>4. Call the API</h3>
    <pre className="hub-pre">{`GET /api/apps/v1/cases                      Authorization: Bearer hjt_…   (cases:read)
GET /api/apps/v1/cases/{caseNo}/results     Authorization: Bearer hjt_…   (results:read)`}</pre>
    <p>Responses only contain the installing centre's data. Patient phone numbers and addresses are never shared. A missing scope returns 403; a revoked installation or suspended app returns 401.</p>
    <h3>5. Webhooks</h3>
    <p>Events are POSTed to your webhook URL with <code>X-Healjour-Event</code> and <code>X-Healjour-Signature: sha256=…</code>, an HMAC-SHA256 of the raw body with your signing secret. Verify it before trusting the event, and return 2xx; failed deliveries are retried with backoff.</p>
    <h3>Scopes</h3>
    <ul>{Object.entries(scopes).map(([s, t]) => <li key={s}><code>{s}</code> {t}</li>)}</ul>
    <h3>Review checklist</h3>
    <p>Privacy policy, only needed scopes, tokens kept server-side, tested in the sandbox, and a support contact.</p>
  </div>;
}
