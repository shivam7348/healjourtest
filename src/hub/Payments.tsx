import { Fragment, useEffect, useState } from "react";
import { Link2, RefreshCw, RotateCcw, Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, Empty, hubApi, ModeBadge, Msg, Pill, rupees, Stats, UrlRow, when } from "./shared";

type Payment = {
  id: string; provider: "razorpay" | "hdfc"; mode: string; bookingRef: string; purpose: string; patientName: string; phone: string;
  amount: number; refunded: number; status: string; shortUrl: string; paymentId?: string; paidAt?: string;
  refunds: Array<{ id: string; amount: number; at: string; reason: string }>; events: Array<{ at: string; type: string; detail: string }>; createdAt: string;
};
type ReconItem = { kind: string; paymentId: string; ours?: number; settled?: number; note: string };
type Recon = { id: string; at: string; provider: string; trigger: string; ok: boolean; counts: Record<string, number>; totals: { gross: number; fees: number; tax: number; net: number }; items: ReconItem[]; error?: string };

const STATUS_TONE: Record<string, "ok" | "bad" | "warn" | "info" | "muted"> = { paid: "ok", created: "info", failed: "bad", partially_refunded: "warn", refunded: "muted" };
const KIND_TEXT: Record<string, string> = { matched: "Matched", amount_mismatch: "Amount differs", missing_in_settlement: "Missing in settlement", pending_settlement: "Settles soon", unknown_settlement: "Unknown to Healjour" };

export default function Payments() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [recon, setRecon] = useState<Recon[]>([]);
  const [modes, setModes] = useState<Record<string, string>>({});
  const [webhookUrl, setWebhookUrl] = useState("");
  const [form, setForm] = useState({ provider: "razorpay", bookingRef: "", patientName: "", phone: "", email: "", amount: "", purpose: "Lab tests" });
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = async () => {
    try {
      const d = await hubApi<{ payments: Payment[]; recon: Recon[]; modes: Record<string, string>; webhookUrl: string }>("/api/hub/payments");
      setPayments(d.payments); setRecon(d.recon); setModes(d.modes); setWebhookUrl(d.webhookUrl);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load."); }
  };
  useEffect(() => { void load(); }, []);

  const run = async (task: () => Promise<string>) => {
    setBusy(true); setError(""); setNotice("");
    try { setNotice(await task()); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Failed."); } finally { setBusy(false); }
  };
  const create = () => run(async () => {
    const d = await hubApi<{ payment: Payment; reused: boolean }>("/api/hub/payments", { body: { ...form, amount: Number(form.amount), email: form.email || undefined } });
    setForm({ ...form, bookingRef: "", patientName: "", phone: "", email: "", amount: "" });
    return d.reused ? "This booking already had a link for that amount; the same link was returned." : `Payment link created: ${d.payment.shortUrl}`;
  });
  const simulate = (p: Payment, outcome: "paid" | "failed", settleAdjust = 0) => run(async () => {
    await hubApi(`/api/hub/payments/${p.id}/simulate`, { body: { outcome, settleAdjust } });
    return outcome === "paid" ? "Gateway webhook received: payment marked paid." : "Gateway webhook received: payment failed.";
  });
  const refund = (p: Payment) => {
    const left = p.amount - p.refunded;
    const value = window.prompt(`Refund amount in ₹ (up to ${left}):`, String(left));
    if (!value) return;
    const reason = window.prompt("Reason for the refund:", "Test cancelled by patient");
    if (!reason) return;
    void run(async () => { await hubApi(`/api/hub/payments/${p.id}/refund`, { body: { amount: Number(value), reason } }); return `Refund of ₹${value} sent to the gateway.`; });
  };
  const reconcileNow = (provider: string) => run(async () => {
    const r = await hubApi<Recon>("/api/hub/payments/reconcile", { body: { provider } });
    return r.error ? `Reconciliation could not run: ${r.error}` : r.ok ? "Reconciliation: everything matches." : "Reconciliation found items to check (an alert was raised).";
  });

  const paid = payments.filter(p => p.status !== "created" && p.status !== "failed");
  const ready = form.bookingRef.trim().length > 1 && form.patientName.trim().length > 1 && /^\+?[\d\s-]{10,15}$/.test(form.phone) && Number(form.amount) >= 1;
  const latest = recon[0];

  return <div className="hub-stack">
    <Msg error={error} notice={notice} />
    <Stats items={[
      ["Links created", payments.length],
      ["Collected", rupees(paid.reduce((s, p) => s + p.amount, 0))],
      ["Refunded", rupees(payments.reduce((s, p) => s + p.refunded, 0))],
      ["Last reconciliation", latest ? (latest.ok ? "All matched" : "Needs a look") : "Not run", latest && !latest.ok ? "warn" : ""]
    ]} />

    <Card title="Create a payment link" sub="The patient pays by UPI, card or net banking. Healjour hears back by webhook." right={<div className="hub-modes">Razorpay <ModeBadge mode={modes.razorpay} /> HDFC <ModeBadge mode={modes.hdfc} /></div>}>
      <div className="hub-form">
        <label className="field"><span>Gateway</span><select value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })}><option value="razorpay">Razorpay</option><option value="hdfc">HDFC SmartGATEWAY</option></select></label>
        <label className="field"><span>Booking ID</span><input value={form.bookingRef} onChange={e => setForm({ ...form, bookingRef: e.target.value })} placeholder="HJ-…" /></label>
        <label className="field"><span>Patient name</span><input value={form.patientName} onChange={e => setForm({ ...form, patientName: e.target.value })} /></label>
        <label className="field"><span>Mobile</span><input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="10-digit mobile" /></label>
        <label className="field"><span>Email (optional)</span><input value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></label>
        <label className="field"><span>Amount (₹)</span><input type="number" min="1" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} /></label>
        <label className="field hub-wide"><span>For</span><input value={form.purpose} onChange={e => setForm({ ...form, purpose: e.target.value })} /></label>
      </div>
      <div className="builder-actions"><Button variant="default" disabled={busy || !ready} onClick={() => void create()}><Link2 size={14} /> Create link</Button></div>
      <UrlRow label="Webhook URL to register in the Razorpay dashboard" url={webhookUrl} />
    </Card>

    <Card title="Payments" sub="Sandbox mode lets you act as the patient: pay, fail, or pay with a settlement difference to test reconciliation." right={<Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw size={13} /> Refresh</Button>}>
      {payments.length === 0 ? <Empty>No payment links yet.</Empty> : <div className="hub-table-wrap"><table className="hub-table">
        <thead><tr><th>Created</th><th>Patient</th><th>Booking</th><th>Amount</th><th>Status</th><th>Gateway</th><th>Actions</th></tr></thead>
        <tbody>{payments.map(p => <Fragment key={p.id}>
          <tr onClick={() => setOpen(open === p.id ? null : p.id)} className="hub-row">
            <td>{when(p.createdAt)}</td><td><b>{p.patientName}</b><small>{p.phone}</small></td><td><code>{p.bookingRef}</code><small>{p.purpose}</small></td>
            <td>{rupees(p.amount)}{p.refunded > 0 && <small>refunded {rupees(p.refunded)}</small>}</td>
            <td><Pill tone={STATUS_TONE[p.status] ?? "muted"}>{p.status.replace("_", " ")}</Pill></td>
            <td>{p.provider === "razorpay" ? "Razorpay" : "HDFC"} <ModeBadge mode={p.mode} /></td>
            <td className="hub-actions" onClick={e => e.stopPropagation()}>
              {p.mode === "sandbox" && p.status === "created" && <>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void simulate(p, "paid")}>Patient pays</Button>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void simulate(p, "paid", -Math.max(1, Math.round(p.amount * 0.05)))} title="Gateway settles a different amount">Pay (settles less)</Button>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void simulate(p, "failed")}>Fails</Button>
              </>}
              {(p.status === "paid" || p.status === "partially_refunded") && <Button variant="outline" size="sm" disabled={busy} onClick={() => refund(p)}><RotateCcw size={13} /> Refund</Button>}
            </td>
          </tr>
          {open === p.id && <tr className="hub-detail"><td colSpan={7}>
            <div className="hub-detail-grid">
              <div><small>Payment link</small><a href={p.shortUrl} target="_blank" rel="noopener noreferrer" className="log-link">{p.shortUrl}</a></div>
              <div><small>Gateway payment ID</small><code>{p.paymentId ?? "—"}</code></div>
              <div><small>Paid at</small>{when(p.paidAt)}</div>
            </div>
            <ol className="hub-timeline">{p.events.map((e, i) => <li key={i}><b>{e.type}</b> {e.detail}<small>{when(e.at)}</small></li>)}</ol>
          </td></tr>}
        </Fragment>)}</tbody>
      </table></div>}
    </Card>

    <Card title="Settlement reconciliation" sub="Compares what patients paid with what the gateway settled. Runs daily; run it now any time." right={<div className="builder-actions">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void reconcileNow("razorpay")}><Scale size={13} /> Reconcile Razorpay</Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void reconcileNow("hdfc")}><Scale size={13} /> Reconcile HDFC</Button>
    </div>}>
      {recon.length === 0 ? <Empty>No reconciliation run yet.</Empty> : recon.slice(0, 5).map(r => <div key={r.id} className="hub-recon">
        <div className="hub-recon-head">
          <b>{r.provider} · {when(r.at)}</b>{r.error ? <Pill tone="bad">Could not run</Pill> : r.ok ? <Pill tone="ok">All matched</Pill> : <Pill tone="warn">Needs a look</Pill>}
          <small>{r.trigger}</small>
        </div>
        {r.error ? <p className="hub-err">{r.error}</p> : <>
          <div className="hub-chips">{Object.entries(r.counts).filter(([, n]) => n > 0).map(([k, n]) => <span key={k}>{KIND_TEXT[k] ?? k}: <b>{n}</b></span>)}
            <span>Gross {rupees(r.totals.gross)} · fees {rupees(r.totals.fees)} · tax {rupees(r.totals.tax)} · net {rupees(r.totals.net)}</span></div>
          {r.items.filter(i => i.kind !== "matched").length > 0 && <ul className="hub-list">{r.items.filter(i => i.kind !== "matched").map(i => <li key={i.paymentId}>
            <Pill tone={i.kind === "pending_settlement" ? "info" : "warn"}>{KIND_TEXT[i.kind]}</Pill> <code>{i.paymentId}</code> {i.ours !== undefined && `ours ${rupees(i.ours)}`}{i.settled !== undefined && ` · settled ${rupees(i.settled)}`} <small>{i.note}</small>
          </li>)}</ul>}
        </>}
      </div>)}
    </Card>
  </div>;
}
