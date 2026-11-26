"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle, BookOpen, Check, Copy, Download, Info, Menu, Play, Search, TerminalSquare } from "lucide-react";
import { ENDPOINTS, GUIDES, NAV_GROUPS, type Block, type Endpoint, type Guide } from "../lib/api-docs";
import { ThemeToggle } from "../lib/theme";
import { DevConsole } from "./Console";

const BASE = "/developers";
const origin = () => (typeof window === "undefined" ? "" : window.location.origin);
const withBase = (s: string) => s.replaceAll("{BASE_URL}", origin());

// ---------- small pieces ----------
function useCopy() {
  const [copied, setCopied] = useState("");
  const copy = (key: string, text: string) => { void navigator.clipboard?.writeText(text); setCopied(key); setTimeout(() => setCopied(""), 1400); };
  return { copied, copy };
}

function highlight(code: string, lang: string): ReactNode {
  if (lang !== "json") return code;
  // Keys, strings, numbers and literals, for readable JSON.
  const parts: ReactNode[] = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(-?\d+(?:\.\d+)?)\b|\b(true|false|null)\b/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(code))) {
    if (m.index > last) parts.push(code.slice(last, m.index));
    if (m[1]) parts.push(<span key={i++} className={m[2] ? "k" : "s"}>{m[1]}</span>, m[2] ?? "");
    else parts.push(<span key={i++} className="n">{m[0]}</span>);
    last = re.lastIndex;
  }
  parts.push(code.slice(last));
  return parts;
}

export function CodeTabs({ tabs }: { tabs: Array<{ label: string; lang: string; code: string }> }) {
  const [i, setI] = useState(0);
  const { copied, copy } = useCopy();
  const tab = tabs[Math.min(i, tabs.length - 1)];
  return <div className="dv-code">
    <div className="dv-code-head">
      {tabs.map((t, n) => <button key={t.label} type="button" className={n === i ? "on" : ""} onClick={() => setI(n)}>{t.label}</button>)}
      <button type="button" className="dv-copy" onClick={() => copy("code", tab.code)} aria-label="Copy code">{copied === "code" ? <Check size={14} /> : <Copy size={14} />}</button>
    </div>
    <pre>{highlight(tab.code, tab.lang)}</pre>
  </div>;
}

// ---------- code samples from an endpoint ----------
function examplePath(e: Endpoint) {
  return e.path.replace(/\{(\w+)\}/g, (_m, name) => String(e.params.find(p => p.name === name)?.example ?? `<${name}>`));
}
function samples(e: Endpoint) {
  const url = `${origin()}/api/v1${examplePath(e)}`;
  const body = e.body ? JSON.stringify(e.body, null, 2) : null;
  const auth = e.auth === "bearer";
  const curl = [`curl --request ${e.method} \\`, `  --url '${url}'${auth || body ? " \\" : ""}`,
    ...(auth ? [`  --header 'Authorization: Bearer <accessToken>'${body ? " \\" : ""}`] : []),
    ...(body ? ["  --header 'Content-Type: application/json' \\", `  --data '${JSON.stringify(e.body)}'`] : [])].join("\n");
  const headers = [auth ? `"Authorization": \`Bearer \${accessToken}\`` : "", body ? `"Content-Type": "application/json"` : ""].filter(Boolean);
  const js = [`const res = await fetch("${url}", {`, `  method: "${e.method}",`,
    ...(headers.length ? [`  headers: { ${headers.join(", ")} },`] : []),
    ...(body ? [`  body: JSON.stringify(${body.replace(/\n/g, "\n  ")})`] : []), `});`,
    e.binary ? `const file = await res.blob(); // the report file` : `const { success, data, error } = await res.json();`].join("\n");
  const pyHeaders = [auth ? `"Authorization": f"Bearer {access_token}"` : ""].filter(Boolean);
  const py = [`import requests`, ``, `res = requests.${e.method.toLowerCase()}(`, `    "${url}",`,
    ...(pyHeaders.length ? [`    headers={${pyHeaders.join(", ")}},`] : []),
    ...(body ? [`    json=${body.replace(/true/g, "True").replace(/false/g, "False").replace(/null/g, "None").replace(/\n/g, "\n    ")},`] : []), `)`,
    e.binary ? `open("report.pdf", "wb").write(res.content)` : `print(res.json())`].join("\n");
  return [{ label: "cURL", lang: "bash", code: curl }, { label: "JavaScript", lang: "js", code: js }, { label: "Python", lang: "python", code: py }];
}

// ---------- Try it ----------
const TOKEN_KEY = "hj-dev-token";
function TryIt({ e }: { e: Endpoint }) {
  const pathParams = e.params.filter(p => p.in === "path");
  const queryParams = e.params.filter(p => p.in === "query");
  const [token, setToken] = useState(() => (typeof window === "undefined" ? "" : sessionStorage.getItem(TOKEN_KEY) ?? ""));
  const [values, setValues] = useState<Record<string, string>>({});
  const [body, setBody] = useState(e.body ? JSON.stringify(e.body, null, 2) : "");
  const [out, setOut] = useState<{ status: number; ms: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setValues({}); setBody(e.body ? JSON.stringify(e.body, null, 2) : ""); setOut(null); }, [e.slug]);
  const saveToken = (t: string) => { setToken(t); try { sessionStorage.setItem(TOKEN_KEY, t); } catch { /* ignore */ } };

  const send = async () => {
    setBusy(true); setOut(null);
    const path = e.path.replace(/\{(\w+)\}/g, (_m, n) => encodeURIComponent(values[n] ?? ""));
    const qs = new URLSearchParams(Object.entries(values).filter(([k, v]) => v && queryParams.some(q => q.name === k))).toString();
    const started = performance.now();
    try {
      let payload: string | undefined;
      if (e.body) { JSON.parse(body); payload = body; }
      const res = await fetch(`/api/v1${path}${qs ? `?${qs}` : ""}`, {
        method: e.method, body: payload,
        headers: { ...(payload ? { "Content-Type": "application/json" } : {}), ...(e.auth === "bearer" && token ? { Authorization: `Bearer ${token}` } : {}) }
      });
      const type = res.headers.get("content-type") ?? "";
      const text = type.includes("json") ? JSON.stringify(await res.json(), null, 2) : `<${type || "binary"} file, ${res.headers.get("content-length") ?? "?"} bytes>`;
      setOut({ status: res.status, ms: Math.round(performance.now() - started), text });
      // Getting a token here fills the token box for the other endpoints.
      try { const d = JSON.parse(text); if (d?.data?.accessToken) saveToken(d.data.accessToken); } catch { /* not JSON */ }
    } catch (err) {
      setOut({ status: 0, ms: 0, text: err instanceof SyntaxError ? "The body is not valid JSON." : String(err) });
    } finally { setBusy(false); }
  };

  return <div className="dv-try" id="try">
    <h3><Play size={14} /> Try it</h3>
    {e.auth === "bearer" && <label className="dv-field"><span>Access token</span>
      <input value={token} onChange={ev => saveToken(ev.target.value)} placeholder="hjat_… (run Get access token first)" /></label>}
    {[...pathParams, ...queryParams].map(p => <label key={p.name} className="dv-field"><span>{p.name}{p.required ? " *" : ""} <small>({p.in})</small></span>
      <input value={values[p.name] ?? ""} onChange={ev => setValues({ ...values, [p.name]: ev.target.value })} placeholder={p.example !== undefined ? String(p.example) : p.type} /></label>)}
    {e.body && <label className="dv-field"><span>Body (JSON)</span><textarea value={body} onChange={ev => setBody(ev.target.value)} spellCheck={false} /></label>}
    <button type="button" className="dv-btn primary" disabled={busy} onClick={() => void send()}><Play size={14} /> {busy ? "Sending…" : `Send ${e.method}`}</button>
    {out && <div className="dv-try-out">
      <span className={`dv-status ${out.status >= 200 && out.status < 300 ? "ok" : "err"}`}>{out.status || "Error"}{out.ms ? ` · ${out.ms} ms` : ""}</span>
      <div className="dv-code"><pre>{highlight(out.text, "json")}</pre></div>
    </div>}
  </div>;
}

// ---------- pages ----------
function Blocks({ blocks }: { blocks: Block[] }) {
  return <>{blocks.map((b, i) => {
    switch (b.t) {
      case "p": return <p key={i}>{withBase(b.text)}</p>;
      case "h": return <h2 key={i}>{b.text}</h2>;
      case "list": return <ul key={i}>{b.items.map((x, j) => <li key={j}>{withBase(x)}</li>)}</ul>;
      case "steps": return <ol key={i} className="dv-steps">{b.items.map((s, j) => <li key={j}><b>{s.title}</b>{s.text}</li>)}</ol>;
      case "code": return <CodeTabs key={i} tabs={[{ label: { bash: "Terminal", json: "JSON", javascript: "Node.js", python: "Python", http: "HTTP", text: "URL" }[b.lang] ?? b.lang, lang: b.lang, code: withBase(b.code) }]} />;
      case "note": return <div key={i} className={`dv-note ${b.tone}`}>{b.tone === "warn" ? <AlertTriangle size={16} /> : <Info size={16} />}<span>{b.text}</span></div>;
      case "cards": return <div key={i} className="dv-cards">{b.items.map(c => <Link key={c.href} className="dv-card" href={`${BASE}/${c.href}`}><b>{c.title}</b><span>{c.text}</span></Link>)}</div>;
      case "table": return <table key={i} className="dv-table"><thead><tr>{b.head.map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}>{k === 0 ? <code>{c}</code> : c}</td>)}</tr>)}</tbody></table>;
    }
  })}</>;
}

function GuidePage({ g }: { g: Guide }) {
  return <article className="dv-page">
    <div className="dv-eyebrow">{g.group}</div>
    <h1>{g.title}</h1>
    <p className="dv-lead">{g.summary}</p>
    <Blocks blocks={g.blocks} />
  </article>;
}

function EndpointPage({ e }: { e: Endpoint }) {
  const groups = (["path", "query", "body"] as const).map(where => [where, e.params.filter(p => p.in === where)] as const).filter(([, list]) => list.length);
  const { copied, copy } = useCopy();
  return <article className="dv-page wide">
    <div className="dv-ep">
      <div>
        <div className="dv-eyebrow">{e.group}</div>
        <h1>{e.title}</h1>
        <p className="dv-lead">{e.summary}</p>
        <div className="dv-path">
          <span className={`dv-method ${e.method}`}>{e.method}</span><code>/api/v1{e.path}</code>
          <button type="button" className="dv-btn sm" onClick={() => copy("path", `${origin()}/api/v1${e.path}`)}>{copied === "path" ? <Check size={13} /> : <Copy size={13} />}</button>
          <a className="dv-btn sm primary" href="#try"><Play size={12} /> Try it</a>
        </div>
        <div className="dv-badges">
          {e.appTypes.map(t => <span key={t} className={`dv-badge ${t}`}>{t === "partner" ? "Partner apps" : "Lab apps"}</span>)}
          <span className="dv-badge">{e.auth === "bearer" ? "Bearer token" : "No token"}</span>
        </div>
        {e.description?.map((d, i) => <p key={i}>{d}</p>)}
        {e.auth === "bearer" && <><h2>Authorization</h2><div className="dv-params"><div className="dv-param"><div className="dv-param-head"><code>Authorization</code><small>header · string</small><em>required</em></div><p>Bearer access token from <Link href={`${BASE}/auth-token`}>Get access token</Link>.</p></div></div></>}
        {groups.map(([where, list]) => <section key={where}>
          <h2>{where === "path" ? "Path parameters" : where === "query" ? "Query parameters" : "Body"}</h2>
          <div className="dv-params">{list.map(p => <div key={p.name} className="dv-param">
            <div className="dv-param-head"><code>{p.name}</code><small>{p.type}</small>{p.required && <em>required</em>}</div>
            <p>{p.description}{p.example !== undefined && <> Example: <code>{typeof p.example === "string" ? p.example : JSON.stringify(p.example)}</code></>}</p>
          </div>)}</div>
        </section>)}
        <h2>Responses</h2>
        <table className="dv-table"><thead><tr><th>Status</th><th>Meaning</th></tr></thead>
          <tbody>{e.responses.map(r => <tr key={r.status}><td><code>{r.status}</code></td><td>{r.description}</td></tr>)}</tbody></table>
        <TryIt e={e} />
      </div>
      <div className="dv-ep-right">
        <CodeTabs tabs={samples(e)} />
        <CodeTabs tabs={e.responses.map(r => ({ label: String(r.status), lang: "json", code: typeof r.example === "string" ? r.example : JSON.stringify(r.example, null, 2) }))} />
      </div>
    </div>
  </article>;
}

// ---------- shell ----------
export default function DevSite() {
  const pathname = usePathname() ?? BASE;
  const slug = pathname.replace(/^\/developers\/?/, "").split("/")[0] || "introduction";
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState(false);
  useEffect(() => { setMenu(false); setQ(""); document.querySelector(".dv")?.scrollTo({ top: 0 }); }, [slug]);

  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return [...GUIDES.map(g => ({ slug: g.slug, title: g.title, sub: g.group, method: null as string | null, text: `${g.title} ${g.summary}` })),
      ...ENDPOINTS.map(e => ({ slug: e.slug, title: e.title, sub: e.path, method: e.method, text: `${e.title} ${e.path} ${e.summary}` }))]
      .filter(x => x.text.toLowerCase().includes(t)).slice(0, 8);
  }, [q]);

  const guide = GUIDES.find(g => g.slug === slug);
  const endpoint = ENDPOINTS.find(e => e.slug === slug);
  const isConsole = slug === "console";
  useEffect(() => { document.title = `${isConsole ? "Console" : guide?.title ?? endpoint?.title ?? "Docs"} · Healjour Developers`; }, [slug]);

  return <div className="dv">
    <header className="dv-top">
      <button type="button" className="dv-btn sm dv-burger" aria-label="Menu" onClick={() => setMenu(!menu)}><Menu size={16} /></button>
      <Link className="dv-logo" href={BASE}><img src="/healjour-logo.png" alt="Healjour" /><span>Developers</span></Link>
      <nav className="dv-tabs">
        <Link href={BASE} className={!isConsole ? "on" : ""}><BookOpen size={14} /> Docs</Link>
        <Link href={`${BASE}/console`} className={isConsole ? "on" : ""}><TerminalSquare size={14} /> Console</Link>
      </nav>
      <div className="dv-search">
        <Search size={15} />
        <input value={q} onChange={ev => setQ(ev.target.value)} placeholder="Search docs and endpoints" aria-label="Search docs" />
        {results.length > 0 && <ul>{results.map(r => <li key={r.slug}><Link href={`${BASE}/${r.slug}`}>{r.method && <span className={`dv-method ${r.method}`}>{r.method}</span>}{r.title}<small>{r.sub}</small></Link></li>)}</ul>}
      </div>
      <div className="dv-top-actions">
        <a className="dv-btn sm" href="/api/v1/openapi.json" target="_blank" rel="noopener noreferrer" title="OpenAPI spec for Postman / Insomnia"><Download size={13} /> OpenAPI</a>
        <ThemeToggle />
        <Link className="dv-btn sm primary" href={`${BASE}/console`}>Get API keys</Link>
      </div>
    </header>
    <div className="dv-shell">
      <aside className={`dv-side${menu ? " open" : ""}`}>
        {NAV_GROUPS.map(group => <div key={group}>
          <h4>{group}</h4>
          {GUIDES.filter(g => g.group === group).map(g => <Link key={g.slug} href={`${BASE}/${g.slug}`} className={slug === g.slug ? "on" : ""}>{g.title}</Link>)}
          {ENDPOINTS.filter(e => e.group === group).map(e => <Link key={e.slug} href={`${BASE}/${e.slug}`} className={slug === e.slug ? "on" : ""}><span className={`dv-method ${e.method}`}>{e.method === "DELETE" ? "DEL" : e.method}</span>{e.title}</Link>)}
        </div>)}
      </aside>
      <main className="dv-main">
        {isConsole ? <DevConsole /> : guide ? <GuidePage g={guide} /> : endpoint ? <EndpointPage e={endpoint} /> :
          <article className="dv-page"><h1>Page not found</h1><p className="dv-lead">This page does not exist. <Link href={BASE}>Back to the introduction</Link>.</p></article>}
        <footer className="dv-footer"><span>© Healjour</span><a href="/api/v1/openapi.json">OpenAPI 3.1</a><Link href={`${BASE}/changelog`}>Changelog</Link><Link href={`${BASE}/errors`}>Errors & rate limits</Link></footer>
      </main>
    </div>
  </div>;
}
