import type { ReactNode } from "react";

/** JSON API helper for the hub pages. Throws the server's error message. */
export async function hubApi<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, init ? { method: init.method ?? "POST", headers: { "Content-Type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) } : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status}).`);
  return data as T;
}

export const when = (iso?: string) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
export const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export function Pill({ tone, children }: { tone: "ok" | "bad" | "warn" | "info" | "muted"; children: ReactNode }) {
  return <span className={`hub-pill ${tone}`}>{children}</span>;
}

export function ModeBadge({ mode }: { mode?: string }) {
  return mode === "live" ? <Pill tone="ok">Live</Pill> : <Pill tone="warn">Sandbox</Pill>;
}

export function Msg({ error, notice }: { error?: string; notice?: string }) {
  return <>
    {error && <div className="access-message error">{error}</div>}
    {notice && <div className="access-message success">{notice}</div>}
  </>;
}

export function Card({ title, sub, right, children }: { title: string; sub?: string; right?: ReactNode; children: ReactNode }) {
  return <section className="access-card hub-card">
    <div className="access-card-head"><div><h2>{title}</h2>{sub && <p>{sub}</p>}</div>{right}</div>
    {children}
  </section>;
}

export function Stats({ items }: { items: Array<[string, ReactNode, ("warn" | "")?]> }) {
  return <div className="hub-stats">{items.map(([label, value, tone]) => <div key={label}><small>{label}</small><b className={tone || ""}>{value}</b></div>)}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="hub-empty">{children}</p>;
}

/** A copyable URL row (webhook endpoints). */
export function UrlRow({ label, url }: { label: string; url: string }) {
  return <div className="hub-url"><small>{label}</small><code>{url}</code><button type="button" onClick={() => void navigator.clipboard?.writeText(url)}>Copy</button></div>;
}
