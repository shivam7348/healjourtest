// Data protection (DPDP Act 2023, ABDM consent model):
//   - encryption status of personal data at rest (compliance/crypto.ts)
//   - retention policies with a dry run before anything is deleted
//   - consent records export with ABDM purpose codes
//   - data-principal requests: find everything held for a phone number, export it, or erase it
// Payment records are anonymised, not deleted: tax law requires keeping financial records.

import { getStore } from "../store.js";
import { newId } from "../framework/connector.js";
import { blindIndex, decrypt, encrypt, encryptionStatus } from "../compliance/crypto.js";
import { listPatients, recordAudit } from "../identity.js";
import type { Appointment } from "../models.js";
import type { Lead } from "./leads.js";
import type { Payment } from "./payments.js";
import type { Message } from "./comms.js";

export type RetentionPolicy = { collection: string; label: string; dateField: string; days: number; onlyWhere?: Record<string, unknown>; deletable: boolean; reason?: string };
const DEFAULT_POLICIES: RetentionPolicy[] = [
  { collection: "messages", label: "Patient messages (SMS, email)", dateField: "createdAt", days: 180, deletable: true },
  { collection: "callLogs", label: "Call and IVR logs", dateField: "at", days: 180, deletable: true },
  { collection: "leads", label: "Marketing leads", dateField: "receivedAt", days: 365, deletable: true },
  { collection: "connectorCalls", label: "Partner call log", dateField: "at", days: 90, deletable: true },
  { collection: "connectorDeadLetters", label: "Delivered dead letters", dateField: "at", days: 30, onlyWhere: { resolved: true }, deletable: true },
  { collection: "connectorIdempotency", label: "Idempotency keys", dateField: "at", days: 2, deletable: true },
  { collection: "paymentWebhookEvents", label: "Payment webhook event IDs", dateField: "at", days: 90, deletable: true },
  { collection: "payments", label: "Payments", dateField: "createdAt", days: 2920, deletable: false, reason: "Kept 8 years for tax and audit; personal fields can be anonymised on request." }
];
const SETTINGS = "complianceSettings";
const REQUESTS = "dataRequests";

export async function getRetention() {
  const doc = await getStore().docGet<{ id: string; days: Record<string, number>; autoApply: boolean }>(SETTINGS, "retention");
  return { policies: DEFAULT_POLICIES.map(p => ({ ...p, days: doc?.days?.[p.collection] ?? p.days })), autoApply: doc?.autoApply ?? false };
}
export async function saveRetention(days: Record<string, number>, autoApply: boolean) {
  const clean = Object.fromEntries(Object.entries(days).filter(([k, v]) => DEFAULT_POLICIES.some(p => p.collection === k && p.deletable) && Number.isInteger(v) && v >= 1 && v <= 3650));
  await getStore().docPut(SETTINGS, { id: "retention", days: clean, autoApply });
  return getRetention();
}

/** Counts (dry run) or deletes records older than each policy allows. */
export async function runRetention(apply: boolean) {
  const store = getStore();
  const { policies } = await getRetention();
  const results: Array<{ collection: string; label: string; days: number; expired: number; deleted: number; note?: string }> = [];
  for (const p of policies) {
    if (!p.deletable) { results.push({ collection: p.collection, label: p.label, days: p.days, expired: 0, deleted: 0, note: p.reason }); continue; }
    const cutoff = Date.now() - p.days * 86_400_000;
    const docs = await store.docList<Record<string, any> & { id: string }>(p.collection, p.onlyWhere);
    const expired = docs.filter(d => { const t = Date.parse(String(d[p.dateField] ?? "")); return Number.isFinite(t) && t < cutoff; });
    let deleted = 0;
    if (apply) for (const d of expired) { await store.docDelete(p.collection, d.id); deleted++; }
    results.push({ collection: p.collection, label: p.label, days: p.days, expired: expired.length, deleted });
  }
  if (apply) await recordAudit({ actor: "retention_job", action: "retention.applied", detail: results.map(r => `${r.collection}: ${r.deleted}`).join(", ") });
  return { applied: apply, results };
}

// ABDM consent purpose codes (Health Information purpose of use).
const ABDM_PURPOSE: Record<string, { code: string; text: string }> = {
  treatment: { code: "CAREMGT", text: "Care Management" },
  claims: { code: "HPAYMT", text: "Healthcare Payment" },
  underwriting: { code: "HPAYMT", text: "Healthcare Payment" },
  research: { code: "DSRCH", text: "Disease Specific Healthcare Research" },
  wellness: { code: "PATRQT", text: "Self Requested" },
  marketplace: { code: "PATRQT", text: "Self Requested" }
};

export async function consentRecords() {
  const patients = await listPatients();
  return patients.flatMap(p => p.consents.map(c => ({
    healjourId: p.healjourId, purpose: c.purpose, abdmPurposeCode: ABDM_PURPOSE[c.purpose]?.code ?? "", abdmPurpose: ABDM_PURPOSE[c.purpose]?.text ?? "",
    granted: c.granted, grantedAt: c.grantedAt, expiresAt: c.expiresAt ?? "",
    state: !c.granted ? "DENIED" : c.expiresAt && Date.parse(c.expiresAt) < Date.now() ? "EXPIRED" : "GRANTED"
  })));
}

/** Everything held about one phone number, decrypted, for an access request. */
export async function findByPhone(phone: string) {
  const store = getStore();
  const idx = blindIndex("phone", phone);
  const last10 = phone.replace(/\D/g, "").slice(-10);
  const same = (v?: string) => Boolean(v) && v!.replace(/\D/g, "").slice(-10) === last10;
  const [leads, payments, messages, appointments, results, patients] = await Promise.all([
    store.docList<Lead>("leads", { phoneIndex: idx }),
    store.docList<Payment>("payments", { phoneIndex: idx }),
    store.docList<Message>("messages", { toIndex: idx }),
    store.listAppointments(),
    store.docList<{ id: string; contact: string; patientName: string; tests?: unknown; receivedAt: string; reportUrl?: string }>("flabsResults"),
    listPatients()
  ]);
  return {
    leads: leads.map(l => ({ id: l.id, source: l.source, campaign: l.campaign, name: decrypt<string>(l.nameEnc), email: l.emailEnc ? decrypt<string>(l.emailEnc) : "", status: l.status, receivedAt: l.receivedAt })),
    payments: payments.map(p => ({ id: p.id, provider: p.provider, bookingRef: p.bookingRef, name: decrypt<string>(p.patientNameEnc), amount: p.amount / 100, status: p.status, createdAt: p.createdAt })),
    messages: messages.map(m => ({ id: m.id, channel: m.channel, template: m.template, text: decrypt<string>(m.bodyEnc), status: m.status, createdAt: m.createdAt })),
    appointments: (appointments as Appointment[]).filter(a => same(a.contact)).map(a => ({ id: a.id, bookingId: a.integratorID, name: a.patientName, tests: a.tests, status: a.status, createdAt: a.createdAt })),
    results: results.filter(r => same(r.contact)).map(r => ({ billId: r.id, name: r.patientName, tests: r.tests, receivedAt: r.receivedAt, reportUrl: r.reportUrl })),
    patients: patients.filter(p => p.phones.some(same)).map(p => ({ healjourId: p.healjourId, name: [p.givenName, p.familyName].filter(Boolean).join(" "), consents: p.consents }))
  };
}

/** Erasure request: removes or anonymises everything held for a phone number. Payments keep amounts, lose identity. */
export async function eraseByPhone(phone: string, by: string, reason: string) {
  const store = getStore();
  const found = await findByPhone(phone);
  const idx = blindIndex("phone", phone);
  const last10 = phone.replace(/\D/g, "").slice(-10);
  const erasedPhone = encrypt("erased");
  for (const l of await store.docList<Lead>("leads", { phoneIndex: idx })) await store.docDelete("leads", l.id);
  for (const m of await store.docList<Message>("messages", { toIndex: idx })) await store.docDelete("messages", m.id);
  for (const p of await store.docList<Payment>("payments", { phoneIndex: idx })) {
    await store.docPut("payments", { ...p, patientNameEnc: encrypt("Erased"), phoneEnc: erasedPhone, phoneIndex: `erased-${p.id}`, emailEnc: undefined });
  }
  for (const a of await store.listAppointments()) {
    if (a.contact && a.contact.replace(/\D/g, "").slice(-10) === last10) await store.saveAppointment({ ...a, patientName: "Erased", contact: "", address: undefined, updatedAt: new Date().toISOString() });
  }
  for (const r of await store.docList<{ id: string; contact: string; patientName: string }>("flabsResults")) {
    if (r.contact && r.contact.replace(/\D/g, "").slice(-10) === last10) await store.docPut("flabsResults", { ...r, patientName: "Erased", contact: "" });
  }
  const counts = { leads: found.leads.length, messages: found.messages.length, payments: found.payments.length, appointments: found.appointments.length, results: found.results.length };
  const request = { id: newId("dsr"), at: new Date().toISOString(), type: "erasure", phoneIndex: idx, by, reason, counts };
  await store.docPut(REQUESTS, request);
  await recordAudit({ actor: by, action: "dsr.erasure", detail: `Erased data for a phone number (${reason}): ${JSON.stringify(counts)}` });
  return request;
}

export async function logAccessRequest(phone: string, by: string) {
  const request = { id: newId("dsr"), at: new Date().toISOString(), type: "access", phoneIndex: blindIndex("phone", phone), by, reason: "Data principal access request", counts: {} };
  await getStore().docPut(REQUESTS, request);
  await recordAudit({ actor: by, action: "dsr.access", detail: "Exported data held for a phone number." });
  return request;
}

export const listDataRequests = async () => (await getStore().docList<{ id: string; at: string }>(REQUESTS)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100);
export const complianceStatus = () => encryptionStatus();
