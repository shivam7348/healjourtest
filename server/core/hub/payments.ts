// Payments: payment links, signed webhooks, refunds and settlement reconciliation (Razorpay, HDFC SmartGATEWAY).
// Every gateway call goes through the connector framework (retries, idempotency, dead letters).
// Patient name and phone are stored encrypted; a blind index lets us search by phone.

import { createHmac, timingSafeEqual } from "node:crypto";
import { getStore } from "../store.js";
import { callConnector, newId } from "../framework/connector.js";
import { sandboxMarkPaid } from "../framework/sandbox-partners.js";
import { blindIndex, decrypt, encrypt, mask } from "../compliance/crypto.js";
import { connectorMode } from "./connectors.js";
import { raiseAlert } from "./alerts.js";

export type Provider = "razorpay" | "hdfc";
export type PaymentStatus = "created" | "paid" | "failed" | "partially_refunded" | "refunded";
export type Payment = {
  id: string; provider: Provider; bookingRef: string; purpose: string;
  patientNameEnc: string; phoneEnc: string; phoneIndex: string; emailEnc?: string;
  amount: number; currency: "INR"; status: PaymentStatus;
  linkId: string; shortUrl: string; paymentId?: string; paidAt?: string;
  refunded: number; refunds: Array<{ id: string; amount: number; status: string; at: string; reason: string }>;
  events: Array<{ at: string; type: string; detail: string }>;
  createdAt: string; updatedAt: string;
};
export type ReconItem = { kind: "matched" | "amount_mismatch" | "missing_in_settlement" | "pending_settlement" | "unknown_settlement"; paymentId: string; ours?: number; settled?: number; note: string };
export type ReconRun = {
  id: string; at: string; provider: Provider; trigger: string; ok: boolean;
  counts: Record<ReconItem["kind"], number>; totals: { gross: number; fees: number; tax: number; net: number };
  items: ReconItem[]; error?: string;
};

const PAYMENTS = "payments";
const EVENTS = "paymentWebhookEvents";
const RECON = "reconciliationRuns";
const SANDBOX_WEBHOOK_SECRET = "sandbox-webhook-secret";

const webhookSecret = (provider: Provider) => {
  const env = provider === "razorpay" ? process.env.RAZORPAY_WEBHOOK_SECRET : process.env.HDFC_WEBHOOK_SECRET;
  if (env?.trim()) return env.trim();
  return connectorMode(provider) === "sandbox" ? SANDBOX_WEBHOOK_SECRET : "";
};

const addEvent = (p: Payment, type: string, detail: string) => { p.events.push({ at: new Date().toISOString(), type, detail }); p.updatedAt = new Date().toISOString(); };

/** What the admin screen shows: names and phones masked, amounts in rupees. */
export function viewPayment(p: Payment) {
  return {
    id: p.id, provider: p.provider, mode: connectorMode(p.provider), bookingRef: p.bookingRef, purpose: p.purpose,
    patientName: decrypt<string>(p.patientNameEnc), phone: mask(decrypt<string>(p.phoneEnc)),
    amount: p.amount / 100, refunded: p.refunded / 100, status: p.status, linkId: p.linkId, shortUrl: p.shortUrl,
    paymentId: p.paymentId, paidAt: p.paidAt, refunds: p.refunds.map(r => ({ ...r, amount: r.amount / 100 })), events: p.events,
    createdAt: p.createdAt, updatedAt: p.updatedAt
  };
}

export async function createPaymentLink(input: { provider: Provider; bookingRef: string; patientName: string; phone: string; email?: string; amountRupees: number; purpose: string }) {
  const amount = Math.round(input.amountRupees * 100);
  const result = await callConnector(input.provider, "createPaymentLink", {
    idempotencyKey: `plink-${input.provider}-${input.bookingRef}-${amount}`,
    body: {
      amount, currency: "INR", description: input.purpose, reference_id: input.bookingRef,
      customer: { name: input.patientName, contact: input.phone, ...(input.email ? { email: input.email } : {}) },
      notify: { sms: false, email: false }, reminder_enable: false, notes: { healjour_booking: input.bookingRef }
    }
  });
  if (!result.ok) return { ok: false as const, error: result.error ?? "The gateway did not create the link.", deadLetterId: result.deadLetterId };
  const d = result.data as { id?: string; short_url?: string; order_id?: string; payment_links?: { web?: string } };
  const linkId = d.id ?? d.order_id ?? "";
  const store = getStore();
  // The same booking and amount returns the same link (idempotency), so reuse its record.
  const existing = (await store.docList<Payment>(PAYMENTS, { linkId }))[0];
  if (existing) return { ok: true as const, payment: viewPayment(existing), reused: true };
  const now = new Date().toISOString();
  const p: Payment = {
    id: newId("pmt"), provider: input.provider, bookingRef: input.bookingRef, purpose: input.purpose,
    patientNameEnc: encrypt(input.patientName), phoneEnc: encrypt(input.phone), phoneIndex: blindIndex("phone", input.phone),
    ...(input.email ? { emailEnc: encrypt(input.email) } : {}),
    amount, currency: "INR", status: "created", linkId, shortUrl: d.short_url ?? d.payment_links?.web ?? "",
    refunded: 0, refunds: [], events: [], createdAt: now, updatedAt: now
  };
  addEvent(p, "link.created", `Link ${linkId} for ₹${(amount / 100).toFixed(2)}`);
  await store.docPut(PAYMENTS, p);
  return { ok: true as const, payment: viewPayment(p), reused: false };
}

/** Constant-time check of the gateway's HMAC-SHA256 signature over the raw request body. */
export function verifySignature(provider: Provider, rawBody: string, signature: string) {
  const secret = webhookSecret(provider);
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Handles one gateway webhook (Razorpay event format). Duplicate deliveries are ignored by event ID. */
export async function handlePaymentWebhook(provider: Provider, rawBody: string, signature: string, eventId: string): Promise<{ status: number; outcome: string }> {
  if (!verifySignature(provider, rawBody, signature)) return { status: 401, outcome: "bad_signature" };
  let event: any;
  try { event = JSON.parse(rawBody); } catch { return { status: 400, outcome: "bad_json" }; }
  const store = getStore();
  const id = eventId || `${event.event}:${event.created_at ?? ""}:${event.payload?.payment?.entity?.id ?? ""}`;
  if (await store.docGet(EVENTS, `${provider}:${id}`)) return { status: 200, outcome: "duplicate" };
  await store.docPut(EVENTS, { id: `${provider}:${id}`, at: new Date().toISOString(), event: event.event });

  const linkId: string | undefined = event.payload?.payment_link?.entity?.id ?? event.payload?.payment?.entity?.notes?.payment_link_id;
  const payment = linkId ? (await store.docList<Payment>(PAYMENTS, { linkId }))[0] : undefined;
  if (!payment) return { status: 200, outcome: "unknown_payment" };   // 200 so the gateway does not retry forever

  const entity = event.payload?.payment?.entity ?? {};
  switch (event.event) {
    case "payment_link.paid":
    case "payment.captured":
      if (payment.status === "created" || payment.status === "failed") {
        payment.status = "paid"; payment.paymentId = entity.id; payment.paidAt = new Date().toISOString();
        addEvent(payment, "payment.paid", `Paid ₹${(Number(entity.amount ?? payment.amount) / 100).toFixed(2)} (${entity.method ?? "online"}), payment ${entity.id}`);
      }
      break;
    case "payment.failed":
      if (payment.status === "created") { payment.status = "failed"; addEvent(payment, "payment.failed", entity.error_description ?? "Payment failed"); }
      break;
    default:
      addEvent(payment, event.event ?? "event", "Received; no change");
  }
  await store.docPut(PAYMENTS, payment);
  return { status: 200, outcome: "processed" };
}

/** Sandbox only: the patient "pays" (or fails). Builds a real-format, signed webhook and sends it through the same handler. */
export async function simulatePayment(id: string, outcome: "paid" | "failed", settleAdjustRupees = 0) {
  const store = getStore();
  const p = await store.docGet<Payment>(PAYMENTS, id);
  if (!p) return { ok: false, error: "Payment not found." };
  if (connectorMode(p.provider) !== "sandbox") return { ok: false, error: "Simulation works only in sandbox mode." };
  let paymentId = `pay_failed_${Date.now()}`;
  if (outcome === "paid") {
    const paid = sandboxMarkPaid(p.provider, p.linkId, Math.round(settleAdjustRupees * 100));
    if (!paid) return { ok: false, error: "The sandbox gateway does not know this link (the server restarted). Create a new link." };
    paymentId = paid.paymentId;
  }
  const event = {
    entity: "event", event: outcome === "paid" ? "payment_link.paid" : "payment.failed", created_at: Math.floor(Date.now() / 1000),
    payload: {
      payment_link: { entity: { id: p.linkId, status: outcome === "paid" ? "paid" : "created" } },
      payment: { entity: { id: paymentId, amount: p.amount, currency: "INR", method: "upi", status: outcome === "paid" ? "captured" : "failed", error_description: outcome === "failed" ? "Payment was declined by the bank" : undefined } }
    }
  };
  const raw = JSON.stringify(event);
  const signature = createHmac("sha256", webhookSecret(p.provider)).update(raw).digest("hex");
  const res = await handlePaymentWebhook(p.provider, raw, signature, newId("evt"));
  return { ok: res.status === 200, outcome: res.outcome };
}

export async function refundPayment(id: string, amountRupees: number | undefined, reason: string) {
  const store = getStore();
  const p = await store.docGet<Payment>(PAYMENTS, id);
  if (!p) return { ok: false, error: "Payment not found." };
  if (!p.paymentId || (p.status !== "paid" && p.status !== "partially_refunded")) return { ok: false, error: "Only a paid payment can be refunded." };
  const left = p.amount - p.refunded;
  const amount = amountRupees === undefined ? left : Math.round(amountRupees * 100);
  if (amount <= 0 || amount > left) return { ok: false, error: `Refund must be between ₹1 and ₹${(left / 100).toFixed(2)}.` };
  const result = await callConnector(p.provider, "refund", {
    params: { paymentId: p.paymentId },
    body: { amount, notes: { reason, healjour_payment: p.id } },
    idempotencyKey: `refund-${p.id}-${p.refunded}-${amount}`
  });
  if (!result.ok) return { ok: false, error: result.error ?? "The gateway did not accept the refund.", deadLetterId: result.deadLetterId };
  const r = result.data as { id: string; status: string };
  p.refunds.push({ id: r.id, amount, status: r.status, at: new Date().toISOString(), reason });
  p.refunded += amount;
  p.status = p.refunded >= p.amount ? "refunded" : "partially_refunded";
  addEvent(p, "refund", `Refunded ₹${(amount / 100).toFixed(2)} (${reason}), refund ${r.id}`);
  await store.docPut(PAYMENTS, p);
  return { ok: true, payment: viewPayment(p) };
}

/** Compares our paid payments with the gateway's settlement report. Mismatches raise an alert. */
export async function reconcile(provider: Provider, trigger: string): Promise<ReconRun> {
  const store = getStore();
  const today = new Date();
  const result = await callConnector(provider, "settlements", { query: { year: String(today.getFullYear()), month: String(today.getMonth() + 1) } });
  const counts: ReconRun["counts"] = { matched: 0, amount_mismatch: 0, missing_in_settlement: 0, pending_settlement: 0, unknown_settlement: 0 };
  const run: ReconRun = { id: newId("recon"), at: new Date().toISOString(), provider, trigger, ok: false, counts, totals: { gross: 0, fees: 0, tax: 0, net: 0 }, items: [] };
  if (!result.ok) {
    run.error = result.error ?? "Settlement report could not be fetched.";
    await store.docPut(RECON, run);
    return run;
  }
  const settled = ((result.data as { items?: any[] }).items ?? []).filter(i => i.type === "payment");
  const bySettled = new Map(settled.map(i => [String(i.entity_id), i]));
  const ours = (await store.docList<Payment>(PAYMENTS, { provider })).filter(p => p.paymentId && p.status !== "created" && p.status !== "failed");
  const oursIds = new Set(ours.map(p => p.paymentId!));
  for (const p of ours) {
    const s = bySettled.get(p.paymentId!);
    if (!s) {
      const ageDays = p.paidAt ? (Date.now() - Date.parse(p.paidAt)) / 86_400_000 : 0;
      const kind = ageDays > 3 ? "missing_in_settlement" : "pending_settlement";
      run.items.push({ kind, paymentId: p.paymentId!, ours: p.amount / 100, note: kind === "pending_settlement" ? "Paid recently; settles in T+1 to T+3 days." : "Paid more than 3 days ago and still not settled." });
      counts[kind]++;
      continue;
    }
    run.totals.gross += s.amount; run.totals.fees += s.fee; run.totals.tax += s.tax; run.totals.net += s.credit;
    if (Number(s.amount) !== p.amount) {
      run.items.push({ kind: "amount_mismatch", paymentId: p.paymentId!, ours: p.amount / 100, settled: s.amount / 100, note: "Settled amount differs from what the patient paid." });
      counts.amount_mismatch++;
    } else {
      run.items.push({ kind: "matched", paymentId: p.paymentId!, ours: p.amount / 100, settled: s.amount / 100, note: "Matches." });
      counts.matched++;
    }
  }
  for (const s of settled) {
    if (!oursIds.has(String(s.entity_id))) {
      run.items.push({ kind: "unknown_settlement", paymentId: String(s.entity_id), settled: s.amount / 100, note: "Settled by the gateway but not recorded in Healjour." });
      counts.unknown_settlement++;
    }
  }
  run.totals = { gross: run.totals.gross / 100, fees: run.totals.fees / 100, tax: run.totals.tax / 100, net: run.totals.net / 100 };
  run.ok = counts.amount_mismatch + counts.missing_in_settlement + counts.unknown_settlement === 0;
  await store.docPut(RECON, run);
  if (!run.ok) {
    await raiseAlert({
      key: `reconciliation:${provider}`, severity: "warning", source: provider, runbook: "reconciliation",
      title: `${provider} settlement does not match our payments`,
      detail: `${counts.amount_mismatch} amount mismatch(es), ${counts.missing_in_settlement} missing, ${counts.unknown_settlement} unknown. Run ${run.id}.`
    });
  }
  return run;
}

export const listPayments = async () => (await getStore().docList<Payment>(PAYMENTS)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 300).map(viewPayment);
export const listReconRuns = async () => (await getStore().docList<ReconRun>(RECON)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 60);
export const PAYMENTS_COLLECTION = PAYMENTS;
