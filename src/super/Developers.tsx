import { useEffect, useState } from "react";
import { ExternalLink, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { when, type Run } from "./parts";

type Account = { id: string; name: string; email: string; company: string; active: boolean; createdAt: string; lastLoginAt?: string; apps: number };
type AppRow = { id: string; clientId: string; name: string; kind: "partner" | "lab"; ownerType: string; ownerId: string; labName: string | null; active: boolean; createdAt: string; lastUsedAt?: string; revokedAt?: string; revokedBy?: string; createdBy: { name: string; email: string }; recentRequests: number };

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) throw new Error(json?.error?.message ?? `Request failed (${res.status}).`);
  return json.data as T;
}

/** Every self-serve developer and every API app (partner and lab). Disable a developer or revoke any app. */
export function DevelopersTab({ run }: { run: Run }) {
  const [data, setData] = useState<{ accounts: Account[]; apps: AppRow[] }>({ accounts: [], apps: [] });
  const [q, setQ] = useState("");
  const load = () => call<{ accounts: Account[]; apps: AppRow[] }>("/api/super/developers").then(setData).catch(() => undefined);
  useEffect(() => { void load(); }, []);
  const match = (s: string) => !q || s.toLowerCase().includes(q.toLowerCase());
  const owner = (a: AppRow) => a.kind === "lab" ? `Lab: ${a.labName ?? a.ownerId}` : data.accounts.find(x => x.id === a.ownerId)?.company ?? "Developer";
  const act = (fn: () => Promise<string>) => run(async () => { const m = await fn(); await load(); return m; });

  return <div className="sa-stack">
    <div className="sa-stats">
      {([["Developers", data.accounts.length], ["Active apps", data.apps.filter(a => a.active).length], ["Partner apps", data.apps.filter(a => a.kind === "partner").length], ["Lab apps", data.apps.filter(a => a.kind === "lab").length]] as Array<[string, number]>)
        .map(([l, v]) => <div key={l}><small>{l}</small><b>{v}</b></div>)}
    </div>
    <div className="sa-filters">
      <label className="corp-search"><Search size={14} /><input placeholder="Search name, email, company, app or Client ID" value={q} onChange={e => setQ(e.target.value)} /></label>
      <a className="su-link" href="/developers" target="_blank" rel="noopener noreferrer"><ExternalLink size={14} /> Open developer site</a>
    </div>
    <section className="access-card">
      <div className="access-card-head"><div><h2>Developer accounts</h2><p>Self-serve sign-ups from /developers. Disabling one also revokes all of their apps.</p></div></div>
      <div className="sa-table-wrap"><table className="sa-table">
        <thead><tr><th>Developer</th><th>Company</th><th>Apps</th><th>Joined</th><th>Last sign-in</th><th>Status</th><th /></tr></thead>
        <tbody>{data.accounts.filter(a => match(`${a.name} ${a.email} ${a.company}`)).map(a => <tr key={a.id}>
          <td><b>{a.name}</b><small>{a.email}</small><small className="id-line">ID {a.id}</small></td><td>{a.company}</td><td>{a.apps}</td>
          <td>{when(a.createdAt)}</td><td>{when(a.lastLoginAt)}</td>
          <td><span className={`sa-pill ${a.active ? "ok" : "bad"}`}>{a.active ? "Active" : "Disabled"}</span></td>
          <td className="sa-actions"><Button variant={a.active ? "destructive" : "outline"} size="sm" onClick={() => {
            if (a.active && !window.confirm(`Disable ${a.email}? All of their API apps are revoked immediately.`)) return;
            void act(async () => { await call(`/api/super/developers/${a.id}`, "PUT", { active: !a.active }); return a.active ? `${a.email} disabled; apps revoked.` : `${a.email} enabled (revoked apps stay revoked).`; });
          }}>{a.active ? "Disable" : "Enable"}</Button></td>
        </tr>)}</tbody>
      </table></div>
      {data.accounts.length === 0 && <p className="sa-muted">No developers have signed up yet.</p>}
    </section>
    <section className="access-card">
      <div className="access-card-head"><div><h2>API apps</h2><p>Partner apps see only bookings they created; lab apps see only their own lab. Revoking stops the keys and every token at once.</p></div></div>
      <div className="sa-table-wrap"><table className="sa-table">
        <thead><tr><th>App</th><th>Type</th><th>Owner</th><th>Created by</th><th>Last used</th><th>Status</th><th /></tr></thead>
        <tbody>{data.apps.filter(a => match(`${a.name} ${a.clientId} ${owner(a)} ${a.createdBy.email}`)).map(a => <tr key={a.id}>
          <td><b>{a.name}</b><small className="id-line">{a.clientId}</small></td>
          <td><span className={`su-chip ${a.kind === "lab" ? "all" : ""}`}>{a.kind === "lab" ? "Lab app" : "Partner app"}</span></td>
          <td>{owner(a)}</td><td>{a.createdBy.name}<small>{a.createdBy.email}</small></td>
          <td>{when(a.lastUsedAt)}{a.recentRequests ? <small>{a.recentRequests} recent call(s)</small> : null}</td>
          <td><span className={`sa-pill ${a.active ? "ok" : "bad"}`}>{a.active ? "Active" : "Revoked"}</span>{a.revokedBy && <small>by {a.revokedBy}</small>}</td>
          <td className="sa-actions">{a.active && <Button variant="destructive" size="sm" onClick={() => {
            if (!window.confirm(`Revoke "${a.name}" (${a.clientId})? Its keys and tokens stop working at once.`)) return;
            void act(async () => { await call(`/api/super/api-apps/${a.id}/revoke`, "POST", {}); return `"${a.name}" revoked.`; });
          }}>Revoke</Button>}</td>
        </tr>)}</tbody>
      </table></div>
      {data.apps.length === 0 && <p className="sa-muted">No API apps yet.</p>}
    </section>
  </div>;
}
