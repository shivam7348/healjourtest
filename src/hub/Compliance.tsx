import { useEffect, useState } from "react";
import { Copy, Download, Lock, Save, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, Empty, hubApi, Msg, Pill, Stats, when } from "./shared";

type Policy = { collection: string; label: string; days: number; deletable: boolean; reason?: string };
type Data = {
  encryption: { algorithm: string; keyConfigured: boolean; keyFingerprint: string };
  retention: { policies: Policy[]; autoApply: boolean };
  requests: Array<{ id: string; at: string; type: string; by: string; reason: string; counts: Record<string, number> }>;
  consentCount: number;
};
type RetentionRun = { applied: boolean; results: Array<{ collection: string; label: string; days: number; expired: number; deleted: number; note?: string }> };
type Found = Record<string, Array<Record<string, unknown>>>;

export default function Compliance() {
  const [d, setD] = useState<Data | null>(null);
  const [days, setDays] = useState<Record<string, number>>({});
  const [autoApply, setAutoApply] = useState(false);
  const [preview, setPreview] = useState<RetentionRun | null>(null);
  const [phone, setPhone] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [erase, setErase] = useState({ reason: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);

  const load = async () => {
    try {
      const x = await hubApi<Data>("/api/hub/compliance");
      setD(x); setDays(Object.fromEntries(x.retention.policies.map(p => [p.collection, p.days]))); setAutoApply(x.retention.autoApply);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load."); }
  };
  useEffect(() => { void load(); }, []);
  const run = async (task: () => Promise<string>) => {
    setBusy(true); setError(""); setNotice("");
    try { setNotice(await task()); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Failed."); } finally { setBusy(false); }
  };
  if (!d) return <Msg error={error} />;

  const saveRetention = () => run(async () => { await hubApi("/api/hub/compliance/retention", { method: "PUT", body: { days, autoApply } }); return "Retention policy saved."; });
  const dryRun = () => run(async () => { setPreview(await hubApi<RetentionRun>("/api/hub/compliance/retention/run", { body: { apply: false } })); return "Dry run done: nothing was deleted."; });
  const apply = () => {
    const total = preview?.results.reduce((n, r) => n + r.expired, 0) ?? 0;
    if (!window.confirm(`Permanently delete ${total} record(s) past their retention period? This cannot be undone.`)) return;
    void run(async () => { const r = await hubApi<RetentionRun>("/api/hub/compliance/retention/run", { body: { apply: true } }); setPreview(r); return `${r.results.reduce((n, x) => n + x.deleted, 0)} record(s) deleted.`; });
  };
  const lookup = () => run(async () => { setFound(await hubApi<Found>("/api/hub/compliance/lookup", { body: { phone } })); return "Search logged as an access request."; });
  const foundJson = found ? JSON.stringify(found, null, 2) : "";
  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(foundJson);
    } catch {
      // Clipboard can be blocked on plain http; fall back to selecting the text so the user can copy it.
      const pre = document.querySelector<HTMLElement>(".hub-pre");
      if (pre) { const r = document.createRange(); r.selectNodeContents(pre); const s = window.getSelection(); s?.removeAllRanges(); s?.addRange(r); }
      setError("Copy was blocked by the browser. The text is selected: press Ctrl+C.");
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };
  const exportFound = () => {
    if (!found) return;
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), phoneLast4: phone.replace(/\D/g, "").slice(-4), data: found }, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `data-export-${phone.replace(/\D/g, "").slice(-4)}.json`; a.click(); URL.revokeObjectURL(a.href);
  };
  const doErase = () => run(async () => {
    const r = await hubApi<{ counts: Record<string, number> }>("/api/hub/compliance/erase", { body: { phone, reason: erase.reason, confirm: erase.confirm } });
    setFound(null); setErase({ reason: "", confirm: "" });
    return `Erased: ${Object.entries(r.counts).map(([k, n]) => `${n} ${k}`).join(", ")}. Payments kept with identity removed.`;
  });
  const last4 = phone.replace(/\D/g, "").slice(-4);
  const total = found ? Object.values(found).reduce((n, list) => n + list.length, 0) : 0;

  return <div className="hub-stack">
    <Msg error={error} notice={notice} />
    <Stats items={[
      ["Encryption at rest", d.encryption.keyConfigured ? "Production key" : "Development key", d.encryption.keyConfigured ? "" : "warn"],
      ["Consent records", d.consentCount],
      ["Data requests handled", d.requests.length],
      ["Auto-delete", d.retention.autoApply ? "On" : "Off (dry run)"]
    ]} />

    <Card title="Encryption" sub="Patient name, phone, email, message text and dead-letter payloads are stored encrypted; phone and email also get a keyed index so records can be found without storing them in clear.">
      <div className="hub-detail-grid">
        <div><small>Algorithm</small><b><Lock size={13} /> {d.encryption.algorithm}</b></div>
        <div><small>Key</small>{d.encryption.keyConfigured ? <Pill tone="ok">DATA_ENCRYPTION_KEY set</Pill> : <Pill tone="warn">Development key: set DATA_ENCRYPTION_KEY</Pill>}</div>
        <div><small>Key fingerprint</small><code>{d.encryption.keyFingerprint}</code></div>
      </div>
      {!d.encryption.keyConfigured && <p className="hub-note">Before real patient data: generate 32 random bytes (<code>openssl rand -base64 32</code>), set it as DATA_ENCRYPTION_KEY on the server, and keep a copy in a secret manager. Losing the key makes stored data unreadable.</p>}
    </Card>

    <Card title="Consent records" sub="Every patient consent with its ABDM purpose code (CAREMGT, HPAYMT, DSRCH, PATRQT) and current state.">
      <div className="hub-actions">
        <a className="hub-link-btn" href="/api/hub/compliance/consents?format=csv"><Download size={13} /> Export CSV</a>
        <a className="hub-link-btn" href="/api/hub/compliance/consents?format=json"><Download size={13} /> Export JSON</a>
      </div>
    </Card>

    <Card title="Data principal requests (DPDP Act)" sub="Find everything held for a mobile number, export it for the patient, or erase it. Every search and erasure is written to the audit trail.">
      <div className="hub-actions">
        <input className="hub-input" value={phone} onChange={e => { setPhone(e.target.value); setFound(null); }} placeholder="Patient mobile number" />
        <Button variant="default" size="sm" disabled={busy || phone.replace(/\D/g, "").length < 10} onClick={() => void lookup()}><Search size={13} /> Find data</Button>
      </div>
      {found && <>
        <div className="hub-chips">{Object.entries(found).map(([k, list]) => <span key={k}>{k}: <b>{list.length}</b></span>)}</div>
        {total === 0 ? <Empty>Nothing held for this number.</Empty> : <>
          <div className="hub-actions">
            <Button variant="outline" size="sm" onClick={exportFound}><Download size={13} /> Download export (JSON)</Button>
            <Button variant="outline" size="sm" onClick={() => void copyJson()}><Copy size={13} /> {copied ? "Copied" : "Copy JSON"}</Button>
          </div>
          <div className="hub-pre-wrap">
            <pre className="hub-pre">{foundJson}</pre>
          </div>
          <div className="hub-review danger">
            <b>Erase this person's data</b>
            <small>Leads and messages are deleted. Bookings, results and payments keep what the law requires but lose name and phone. This cannot be undone.</small>
            <label className="field"><span>Reason</span><input value={erase.reason} onChange={e => setErase({ ...erase, reason: e.target.value })} placeholder="e.g. Patient asked by email on 17 Nov" /></label>
            <label className="field"><span>Type ERASE {last4} to confirm</span><input value={erase.confirm} onChange={e => setErase({ ...erase, confirm: e.target.value })} /></label>
            <div className="hub-actions"><Button variant="destructive" size="sm" disabled={busy || erase.confirm !== `ERASE ${last4}` || erase.reason.trim().length < 5} onClick={() => void doErase()}><Trash2 size={13} /> Erase</Button></div>
          </div>
        </>}
      </>}
      {d.requests.length > 0 && <ul className="hub-list">{d.requests.slice(0, 8).map(r => <li key={r.id}><Pill tone={r.type === "erasure" ? "bad" : "info"}>{r.type}</Pill> {r.by} <small>{when(r.at)}{r.reason ? ` · ${r.reason}` : ""}{Object.keys(r.counts ?? {}).length ? ` · ${JSON.stringify(r.counts)}` : ""}</small></li>)}</ul>}
    </Card>

    <Card title="Retention" sub="How long each kind of record is kept. The daily job deletes expired records only when auto-delete is on; otherwise it only counts them." right={<Button variant="default" size="sm" disabled={busy} onClick={() => void saveRetention()}><Save size={13} /> Save</Button>}>
      <div className="hub-table-wrap"><table className="hub-table">
        <thead><tr><th>Records</th><th>Keep for (days)</th><th>Past retention</th></tr></thead>
        <tbody>{d.retention.policies.map(p => {
          const r = preview?.results.find(x => x.collection === p.collection);
          return <tr key={p.collection}>
            <td><b>{p.label}</b><small><code>{p.collection}</code>{p.reason ? ` · ${p.reason}` : ""}</small></td>
            <td>{p.deletable ? <input className="hub-days" type="number" min={1} max={3650} value={days[p.collection] ?? p.days} onChange={e => setDays({ ...days, [p.collection]: Number(e.target.value) })} /> : `${p.days} (fixed)`}</td>
            <td>{r ? (preview?.applied ? `${r.deleted} deleted` : `${r.expired} record(s)`) : "—"}</td>
          </tr>;
        })}</tbody>
      </table></div>
      <label className="hub-check"><input type="checkbox" checked={autoApply} onChange={e => setAutoApply(e.target.checked)} /> Let the daily job delete expired records automatically</label>
      <div className="hub-actions">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void dryRun()}>Dry run (count only)</Button>
        <Button variant="destructive" size="sm" disabled={busy || !preview || preview.applied || preview.results.every(r => r.expired === 0)} onClick={apply}><Trash2 size={13} /> Delete expired now</Button>
      </div>
    </Card>
  </div>;
}
