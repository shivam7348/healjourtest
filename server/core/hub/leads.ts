// CRM and marketing: capture leads from ads and listings (Meta Lead Ads, Google Ads lead forms, Justdial,
// Practo, website), de-duplicate by phone, push to the CRM (LeadSquared), and track each lead to a booking
// for campaign attribution. Phone, name and email are stored encrypted; a blind index finds repeats.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getStore } from "../store.js";
import { callConnector, newId } from "../framework/connector.js";
import { mapEntity, type MappingSpec } from "../framework/mapping.js";
import { blindIndex, decrypt, encrypt, mask } from "../compliance/crypto.js";

export type LeadSource = "meta" | "google" | "justdial" | "practo" | "website";
export type LeadStatus = "new" | "contacted" | "booked" | "lost";
export type Lead = {
  id: string; source: LeadSource; externalId?: string; campaign: string; adset?: string; ad?: string;
  nameEnc: string; phoneEnc: string; phoneIndex: string; phoneMasked: string; emailEnc?: string;
  city?: string; interest?: string; status: LeadStatus; bookingRef?: string;
  crm: { synced: boolean; id?: string; error?: string };
  duplicates: number; receivedAt: string; updatedAt: string;
  history: Array<{ at: string; event: string; detail: string }>;
};

const LEADS = "leads";
const DEDUPE_WINDOW_MS = 7 * 86_400_000;
export const SOURCES: LeadSource[] = ["meta", "google", "justdial", "practo", "website"];

/** Token in each source's webhook URL. */
export const leadsToken = () => process.env.LEADS_WEBHOOK_TOKEN?.trim() || createHash("sha256").update(`healjour-leads:${process.env.DATA_ENCRYPTION_KEY ?? "dev"}`).digest("hex").slice(0, 24);

// One mapping per source into the common shape { externalId, name, phone, email, city, interest, campaign, adset, ad }.
const MAPS: Record<Exclude<LeadSource, "meta">, MappingSpec> = {
  google: { name: "Google Ads lead form", rules: [
    { to: "externalId", from: "lead_id" },
    { to: "name", from: "_cols.FULL_NAME", transform: "trim" },
    { to: "phone", from: "_cols.PHONE_NUMBER", transform: "phone10", required: true },
    { to: "email", from: "_cols.EMAIL", transform: ["trim", "lower"] },
    { to: "city", from: "_cols.CITY", transform: "trim" },
    { to: "campaign", from: "campaign_id", transform: "string", default: "google" },
    { to: "adset", from: "adgroup_id", transform: "string" },
    { to: "ad", from: "creative_id", transform: "string" }
  ] },
  justdial: { name: "Justdial lead", rules: [
    { to: "externalId", from: "leadid" },
    { to: "name", from: "name", transform: "trim" },
    { to: "phone", from: "mobile", transform: "phone10", required: true },
    { to: "email", from: "email", transform: ["trim", "lower"] },
    { to: "city", from: "city", transform: "trim" },
    { to: "interest", from: "category", transform: "trim" },
    { to: "campaign", from: "area", transform: "trim", default: "justdial" }
  ] },
  practo: { name: "Practo enquiry", rules: [
    { to: "externalId", from: "enquiry_id" },
    { to: "name", from: "patient.name", transform: "trim" },
    { to: "phone", from: "patient.mobile", transform: "phone10", required: true },
    { to: "email", from: "patient.email", transform: ["trim", "lower"] },
    { to: "city", from: "city", transform: "trim" },
    { to: "interest", from: "service", transform: "trim" },
    { to: "campaign", const: "practo" }
  ] },
  website: { name: "Website form", rules: [
    { to: "name", from: "name", transform: "trim" },
    { to: "phone", from: "phone", transform: "phone10", required: true },
    { to: "email", from: "email", transform: ["trim", "lower"] },
    { to: "city", from: "city", transform: "trim" },
    { to: "interest", from: "interest", transform: "trim" },
    { to: "campaign", from: "utm_campaign", transform: "trim", default: "website" },
    { to: "adset", from: "utm_source", transform: "trim" },
    { to: "ad", from: "utm_content", transform: "trim" }
  ] }
};

export const SAMPLE_PAYLOADS: Record<LeadSource, unknown> = {
  meta: { object: "page", entry: [{ id: "PAGE_ID", time: 0, changes: [{ field: "leadgen", value: { leadgen_id: "4422", form_id: "F1", ad_id: "AD9", adgroup_id: "SET3", campaign_id: "Diwali-Full-Body", page_id: "PAGE_ID" } }] }] },
  google: { lead_id: "GL-1001", campaign_id: "Search-Thyroid", adgroup_id: "AG-12", creative_id: "CR-7", google_key: "sandbox-google-key",
    user_column_data: [{ column_id: "FULL_NAME", string_value: "Rohit Verma" }, { column_id: "PHONE_NUMBER", string_value: "+91 98200 11223" }, { column_id: "EMAIL", string_value: "Rohit.V@example.com" }, { column_id: "CITY", string_value: "Mumbai" }] },
  justdial: { leadid: "JD-77812", name: "Meera Iyer", mobile: "9845012345", email: "", city: "Bengaluru", category: "Diagnostic Centres", area: "Indiranagar" },
  practo: { enquiry_id: "PR-5531", patient: { name: "Karan Shah", mobile: "+91-9988776655", email: "karan@example.com" }, city: "Ahmedabad", service: "Lipid profile" },
  website: { name: "Anita Desai", phone: "9123456780", email: "anita@example.com", city: "Delhi", interest: "Diabetes package", utm_campaign: "summer-health", utm_source: "instagram", utm_content: "reel-2" }
};

/** Optional extra checks per source (on top of the URL token). */
export function verifySource(source: LeadSource, rawBody: string, body: any, signatureHeader: string): string | null {
  if (source === "meta" && process.env.META_APP_SECRET?.trim()) {
    const expected = `sha256=${createHmac("sha256", process.env.META_APP_SECRET.trim()).update(rawBody).digest("hex")}`;
    const a = Buffer.from(expected), b = Buffer.from(signatureHeader || "");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return "Meta signature does not match.";
  }
  if (source === "google") {
    const key = process.env.GOOGLE_LEADS_KEY?.trim() || "sandbox-google-key";
    if (body?.google_key !== key) return "google_key does not match.";
  }
  return null;
}

type Normalized = { externalId?: string; name?: string; phone: string; email?: string; city?: string; interest?: string; campaign: string; adset?: string; ad?: string };

/** Turns a source payload into normalized leads (Meta can carry several per delivery). */
async function normalize(source: LeadSource, body: any): Promise<{ leads: Normalized[]; errors: string[] }> {
  if (source === "meta") {
    const changes = (body?.entry ?? []).flatMap((e: any) => e?.changes ?? []).filter((c: any) => c?.field === "leadgen");
    const leads: Normalized[] = [];
    const errors: string[] = [];
    for (const c of changes) {
      const v = c.value ?? {};
      const r = await callConnector("meta-graph", "getLead", { params: { leadgenId: String(v.leadgen_id ?? "") }, idempotencyKey: `meta-lead-${v.leadgen_id}` });
      if (!r.ok) { errors.push(`Lead ${v.leadgen_id}: ${r.error}`); continue; }
      const fields = Object.fromEntries(((r.data as any)?.field_data ?? []).map((f: any) => [f.name, f.values?.[0]]));
      const mapped = mapEntity({ rules: [
        { to: "name", from: "full_name", transform: "trim" },
        { to: "phone", from: "phone_number", transform: "phone10", required: true },
        { to: "email", from: "email", transform: ["trim", "lower"] },
        { to: "city", from: "city", transform: "trim" },
        { to: "interest", from: "which_test_are_you_looking_for?", transform: "trim" }
      ] }, fields);
      if (mapped.errors.length) { errors.push(...mapped.errors); continue; }
      leads.push({ ...(mapped.output as Normalized), externalId: String(v.leadgen_id), campaign: String(v.campaign_id ?? "meta"), adset: v.adgroup_id, ad: v.ad_id });
    }
    return { leads, errors };
  }
  const input = source === "google"
    ? { ...body, _cols: Object.fromEntries((body?.user_column_data ?? []).map((c: any) => [c.column_id, c.string_value])) }
    : body;
  const mapped = mapEntity(MAPS[source], input);
  return mapped.errors.length ? { leads: [], errors: mapped.errors } : { leads: [mapped.output as Normalized], errors: [] };
}

const hist = (l: Lead, event: string, detail: string) => { l.history.push({ at: new Date().toISOString(), event, detail }); l.updatedAt = new Date().toISOString(); };

async function pushToCrm(l: Lead) {
  const fields = [
    { Attribute: "FirstName", Value: decrypt<string>(l.nameEnc) || "Lead" },
    { Attribute: "Phone", Value: decrypt<string>(l.phoneEnc) },
    ...(l.emailEnc ? [{ Attribute: "EmailAddress", Value: decrypt<string>(l.emailEnc) }] : []),
    { Attribute: "Source", Value: l.source },
    { Attribute: "SourceCampaign", Value: l.campaign },
    ...(l.city ? [{ Attribute: "mx_City", Value: l.city }] : [])
  ];
  const r = await callConnector("leadsquared", "captureLead", { body: fields, idempotencyKey: `lsq-${l.id}` });
  l.crm = r.ok ? { synced: true, id: (r.data as any)?.Message?.Id } : { synced: false, error: r.error };
  hist(l, r.ok ? "crm.synced" : "crm.failed", r.ok ? `LeadSquared ${l.crm.id}` : r.error ?? "CRM error");
}

/** Saves leads from one webhook delivery. A phone seen in the last 7 days updates that lead instead of creating another. */
export async function ingestLeads(source: LeadSource, body: unknown) {
  const store = getStore();
  const { leads, errors } = await normalize(source, body);
  const saved: Array<{ id: string; duplicate: boolean }> = [];
  for (const n of leads) {
    const phoneIndex = blindIndex("phone", n.phone);
    const recent = (await store.docList<Lead>(LEADS, { phoneIndex })).find(l => Date.now() - Date.parse(l.receivedAt) < DEDUPE_WINDOW_MS);
    if (recent) {
      recent.duplicates += 1;
      hist(recent, "duplicate", `Same phone again from ${source} (${n.campaign})`);
      await store.docPut(LEADS, recent);
      saved.push({ id: recent.id, duplicate: true });
      continue;
    }
    const now = new Date().toISOString();
    const l: Lead = {
      id: newId("lead"), source, externalId: n.externalId, campaign: n.campaign || source, adset: n.adset, ad: n.ad,
      nameEnc: encrypt(n.name ?? ""), phoneEnc: encrypt(n.phone), phoneIndex, phoneMasked: mask(n.phone), ...(n.email ? { emailEnc: encrypt(n.email) } : {}),
      city: n.city, interest: n.interest, status: "new", crm: { synced: false }, duplicates: 0, receivedAt: now, updatedAt: now, history: []
    };
    hist(l, "received", `From ${source}, campaign ${l.campaign}`);
    await pushToCrm(l);
    await store.docPut(LEADS, l);
    saved.push({ id: l.id, duplicate: false });
  }
  return { saved, errors };
}

export function viewLead(l: Lead) {
  return {
    id: l.id, source: l.source, externalId: l.externalId, campaign: l.campaign, adset: l.adset, ad: l.ad,
    name: decrypt<string>(l.nameEnc), phone: l.phoneMasked, email: l.emailEnc ? decrypt<string>(l.emailEnc) : "",
    city: l.city, interest: l.interest, status: l.status, bookingRef: l.bookingRef, crm: l.crm, duplicates: l.duplicates,
    receivedAt: l.receivedAt, updatedAt: l.updatedAt, history: l.history
  };
}

export async function updateLead(id: string, patch: { status?: LeadStatus; bookingRef?: string }) {
  const store = getStore();
  const l = await store.docGet<Lead>(LEADS, id);
  if (!l) return null;
  if (patch.bookingRef) { l.bookingRef = patch.bookingRef; l.status = "booked"; hist(l, "booked", `Booking ${patch.bookingRef}`); }
  else if (patch.status && patch.status !== l.status) { hist(l, "status", `${l.status} → ${patch.status}`); l.status = patch.status; }
  await store.docPut(LEADS, l);
  return viewLead(l);
}

/** Called when a booking is created: the newest open lead with that phone becomes "booked" (enquiry → booking tracking). */
export async function linkBookingToLead(phone: string, bookingRef: string) {
  if (!phone) return null;
  const store = getStore();
  const open = (await store.docList<Lead>(LEADS, { phoneIndex: blindIndex("phone", phone) }))
    .filter(l => l.status === "new" || l.status === "contacted")
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0];
  if (!open) return null;
  open.bookingRef = bookingRef; open.status = "booked";
  hist(open, "booked", `Booking ${bookingRef} created for this phone`);
  await store.docPut(LEADS, open);
  return open.id;
}

/** Campaign attribution: leads, bookings, conversion and revenue per source and campaign. */
export async function attribution(paidByBooking: Map<string, number>) {
  const leads = await getStore().docList<Lead>(LEADS);
  const rows = new Map<string, { source: string; campaign: string; leads: number; contacted: number; booked: number; lost: number; revenue: number }>();
  for (const l of leads) {
    const key = `${l.source}|${l.campaign}`;
    const r = rows.get(key) ?? { source: l.source, campaign: l.campaign, leads: 0, contacted: 0, booked: 0, lost: 0, revenue: 0 };
    r.leads++;
    if (l.status === "contacted") r.contacted++;
    if (l.status === "booked") { r.booked++; r.revenue += l.bookingRef ? paidByBooking.get(l.bookingRef) ?? 0 : 0; }
    if (l.status === "lost") r.lost++;
    rows.set(key, r);
  }
  return [...rows.values()].map(r => ({ ...r, conversion: r.leads ? Math.round((r.booked / r.leads) * 100) : 0 })).sort((a, b) => b.leads - a.leads);
}

export const listLeads = async () => (await getStore().docList<Lead>(LEADS)).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, 500).map(viewLead);
export const LEADS_COLLECTION = LEADS;
