// Layer 03 - Identity & Consent
// Patient stitch plus audit. Every record is resolved against the master patient index,
// checked against the consent the patient actually gave, and written to a hash-chained
// audit log. Ambiguous matches are quarantined; they are never merged on a guess.
//
// All state lives in the store (MongoDB, or the in-memory fallback), so a stitched
// patient, a linked alias and the audit chain all survive a restart.

import { createHash, randomUUID } from "node:crypto";
import type { CanonicalRecord, LayerIssue, LayerTrace } from "./types.js";
import { isoNow } from "./types.js";
import type { AuditEvent, ConsentPurpose, MasterPatient } from "./models.js";
import { getStore } from "./store.js";
import { auditActorText } from "./portal/actor.js";

export type { AuditEvent, ConsentPurpose, MasterPatient } from "./models.js";

export type MatchMethod = "mrn" | "national_id" | "phone_dob" | "demographic" | "new_patient";

export type IdentityDecision = {
  recordId: string;
  healjourId?: string;
  method: MatchMethod;
  confidence: number;
  candidates: Array<{ healjourId: string; confidence: number; reason: string }>;
  consent: { required: ConsentPurpose[]; granted: ConsentPurpose[]; denied: ConsentPurpose[] };
  quarantined: boolean;
};

export const listPatients = () => getStore().listPatients();
export const listAudit = (limit = 50) => getStore().listAudit(limit);

// The chain's previousHash makes appends order-dependent, so they are serialised
// through this promise rather than racing each other.
let auditTail: Promise<unknown> = Promise.resolve();

export function recordAudit(input: Omit<AuditEvent, "seq" | "at" | "previousHash" | "hash">): Promise<AuditEvent> {
  // During "Login as", every entry also names the Super Admin behind the session.
  const entry = { ...input, actor: auditActorText(input.actor) };
  const next = auditTail.then(async () => {
    const store = getStore();
    const previous = await store.lastAudit();
    const previousHash = previous?.hash ?? "genesis";
    const seq = (previous?.seq ?? 0) + 1;
    const at = isoNow();
    const body = JSON.stringify({ seq, at, ...entry, previousHash });
    const event: AuditEvent = { seq, at, previousHash, hash: createHash("sha256").update(body).digest("hex"), ...entry };
    await store.appendAudit(event);
    return event;
  });
  auditTail = next.catch(() => undefined);
  return next;
}

/** Recompute the chain so tampering with a stored event is visible. */
export async function verifyAuditChain() {
  const events = await getStore().allAudit();
  let previousHash = "genesis";
  for (const event of events) {
    const { seq, at, actor, action, recordId, healjourId, detail, hash } = event;
    const expected = createHash("sha256").update(JSON.stringify({ seq, at, actor, action, recordId, healjourId, detail, previousHash })).digest("hex");
    if (expected !== hash || event.previousHash !== previousHash) return { intact: false, brokenAt: seq };
    previousHash = hash;
  }
  return { intact: true, length: events.length };
}

const digits = (value?: string) => (value ?? "").replace(/\D/g, "");

function scoreCandidate(patient: MasterPatient, incoming: CanonicalRecord["patient"]) {
  // Deterministic identifiers first; they are the only ones trusted on their own.
  if (incoming.mrn && patient.mrns.some(m => m.toLowerCase() === incoming.mrn!.toLowerCase())) {
    return { confidence: 1, method: "mrn" as MatchMethod, reason: `MRN ${incoming.mrn} is already registered to this patient.` };
  }
  if (incoming.nationalId && patient.nationalId && digits(patient.nationalId) === digits(incoming.nationalId)) {
    return { confidence: 1, method: "national_id" as MatchMethod, reason: "National identifier matches exactly." };
  }
  const phoneHit = Boolean(incoming.phone) && patient.phones.some(p => digits(p) === digits(incoming.phone));
  const dobHit = Boolean(incoming.birthDate) && patient.birthDate === incoming.birthDate;
  if (phoneHit && dobHit) {
    return { confidence: 0.95, method: "phone_dob" as MatchMethod, reason: "Phone number and date of birth both match." };
  }

  // Probabilistic fallback. Deliberately conservative: a strong score still has to clear
  // the ambiguity check below before anything is merged.
  let score = 0;
  const reasons: string[] = [];
  const family = (incoming.familyName ?? "").toLowerCase();
  const given = (incoming.givenName ?? "").toLowerCase();
  if (family && family === (patient.familyName ?? "").toLowerCase()) { score += 0.3; reasons.push("family name"); }
  if (given && given === (patient.givenName ?? "").toLowerCase()) { score += 0.3; reasons.push("given name"); }
  if (dobHit) { score += 0.3; reasons.push("date of birth"); }
  if (phoneHit) { score += 0.25; reasons.push("phone"); }
  if (incoming.gender && patient.gender && incoming.gender === patient.gender) { score += 0.1; reasons.push("gender"); }
  else if (incoming.gender && patient.gender && incoming.gender !== "unknown" && patient.gender !== "unknown") { score -= 0.35; reasons.push("gender conflict"); }
  return { confidence: Math.max(0, Math.min(score, 0.94)), method: "demographic" as MatchMethod, reason: reasons.join(", ") || "no shared attributes" };
}

const AUTO_MATCH = 0.9;
const REVIEW_FLOOR = 0.6;

/** Which consent purpose a given destination needs before it may receive the record. */
export const sinkPurpose: Record<string, ConsentPurpose> = {
  insurer_underwriting: "underwriting",
  insurer_claims: "claims",
  health_aggregator: "marketplace",
  corporate_wellness: "wellness",
  healjour_record: "treatment",
  flabs_crm: "treatment"
};

export type IdentityOptions = { requestedSinks: string[]; quarantineOnAmbiguity: boolean };

export async function runIdentityAndConsent(
  records: CanonicalRecord[],
  options: IdentityOptions
): Promise<LayerTrace<Array<{ record: CanonicalRecord; decision: IdentityDecision }>>> {
  const started = Date.now();
  const store = getStore();
  const issues: LayerIssue[] = [];
  const output: Array<{ record: CanonicalRecord; decision: IdentityDecision }> = [];
  const requiredPurposes = [...new Set(options.requestedSinks.map(s => sinkPurpose[s]).filter(Boolean))] as ConsentPurpose[];

  // Read the index once per run; new patients registered mid-run are appended locally
  // so a second record in the same batch matches the identity the first one created.
  const index = await store.listPatients();

  for (const record of records) {
    const scored = index
      .map(patient => ({ patient, ...scoreCandidate(patient, record.patient) }))
      .filter(c => c.confidence > 0)
      .sort((a, b) => b.confidence - a.confidence);

    const best = scored[0];
    const runnerUp = scored[1];
    const candidates = scored.slice(0, 3).map(c => ({ healjourId: c.patient.healjourId, confidence: Number(c.confidence.toFixed(2)), reason: c.reason }));

    let matched: MasterPatient | undefined;
    let method: MatchMethod = "new_patient";
    let confidence = 0;
    let quarantined = false;

    if (best && best.confidence >= AUTO_MATCH) {
      // A near-tie between two different patients is exactly the case that must not be merged.
      if (runnerUp && best.confidence - runnerUp.confidence < 0.1 && runnerUp.confidence >= REVIEW_FLOOR && best.method === "demographic") {
        quarantined = options.quarantineOnAmbiguity;
        issues.push({
          layer: "identity_consent", code: "ambiguous_patient_match", severity: "error", recordId: record.recordId,
          message: `Record matches ${best.patient.healjourId} and ${runnerUp.patient.healjourId} almost equally. Held for human review rather than merged.`
        });
      } else {
        matched = best.patient;
        method = best.method;
        confidence = best.confidence;
      }
    } else if (best && best.confidence >= REVIEW_FLOOR) {
      quarantined = options.quarantineOnAmbiguity;
      confidence = best.confidence;
      method = best.method;
      issues.push({
        layer: "identity_consent", code: "low_confidence_match", severity: "error", recordId: record.recordId,
        message: `Best candidate ${best.patient.healjourId} scored ${best.confidence.toFixed(2)}, below the ${AUTO_MATCH} auto-stitch threshold (${best.reason}).`
      });
    } else if (record.patient.mrn || record.patient.nationalId || record.patient.phone) {
      // No credible candidate: register a new identity rather than attach to the wrong one.
      const created: MasterPatient = {
        healjourId: `HJP-${String((await store.countPatients()) + 1).padStart(6, "0")}`,
        mrns: record.patient.mrn ? [record.patient.mrn] : [],
        nationalId: record.patient.nationalId,
        phones: record.patient.phone ? [record.patient.phone] : [],
        familyName: record.patient.familyName, givenName: record.patient.givenName,
        birthDate: record.patient.birthDate, gender: record.patient.gender,
        consents: [{ purpose: "treatment", granted: true, grantedAt: isoNow() }],
        createdAt: isoNow(), lastSeenAt: isoNow()
      };
      await store.savePatient(created);
      index.push(created);
      matched = created;
      method = "new_patient";
      confidence = 1;
      issues.push({ layer: "identity_consent", code: "new_patient_registered", severity: "info", recordId: record.recordId, message: `No existing patient matched; registered ${created.healjourId} with treatment consent only.` });
      await recordAudit({ actor: "identity_layer", action: "patient.created", recordId: record.recordId, healjourId: created.healjourId, detail: `New master patient created from ${record.source.connectorId}.` });
    }

    if (matched && method !== "new_patient") {
      if (record.patient.mrn && !matched.mrns.some(m => m.toLowerCase() === record.patient.mrn!.toLowerCase())) {
        matched.mrns.push(record.patient.mrn);
        await recordAudit({ actor: "identity_layer", action: "patient.alias_added", recordId: record.recordId, healjourId: matched.healjourId, detail: `Linked source MRN ${record.patient.mrn} from ${record.source.connectorId}.` });
      }
      matched.lastSeenAt = isoNow();
      await store.savePatient(matched);
    }

    const now = Date.now();
    const granted = matched
      ? requiredPurposes.filter(purpose => {
          const consent = matched!.consents.find(c => c.purpose === purpose);
          return Boolean(consent?.granted) && (!consent?.expiresAt || Date.parse(consent.expiresAt) > now);
        })
      : [];
    const denied = requiredPurposes.filter(p => !granted.includes(p));
    for (const purpose of denied) {
      if (!matched) break;
      const consent = matched.consents.find(c => c.purpose === purpose);
      issues.push({
        layer: "identity_consent", code: "consent_not_granted", severity: "warning", recordId: record.recordId,
        message: consent?.expiresAt && Date.parse(consent.expiresAt) <= now
          ? `Consent for ${purpose} expired on ${consent.expiresAt.slice(0, 10)}; the matching destination is dropped.`
          : `Patient has not granted ${purpose} consent; the matching destination is dropped.`
      });
    }

    const decision: IdentityDecision = {
      recordId: record.recordId,
      healjourId: quarantined ? undefined : matched?.healjourId,
      method, confidence: Number(confidence.toFixed(2)), candidates,
      consent: { required: requiredPurposes, granted, denied },
      quarantined: quarantined || !matched
    };

    if (!matched && !quarantined) {
      issues.push({ layer: "identity_consent", code: "unresolvable_identity", severity: "error", recordId: record.recordId, message: "Record carries no usable identifier and could not be stitched." });
    }

    await recordAudit({
      actor: "identity_layer",
      action: decision.quarantined ? "record.quarantined" : "record.stitched",
      recordId: record.recordId,
      healjourId: decision.healjourId,
      detail: decision.quarantined
        ? `Held at identity layer (${method}, confidence ${decision.confidence}).`
        : `Stitched by ${method} at confidence ${decision.confidence}; consent granted for ${granted.join(", ") || "none"}.`
    });

    output.push({ record, decision });
  }

  const passed = output.filter(o => !o.decision.quarantined);
  const errors = issues.filter(i => i.severity === "error");
  const auditCount = await store.countAudit();
  return {
    layer: "identity_consent",
    title: "Identity & Consent",
    status: passed.length === 0 && output.length > 0 ? "failed" : errors.length || issues.some(i => i.severity === "warning") ? "passed_with_warnings" : "passed",
    durationMs: Date.now() - started,
    summary: `${passed.length} of ${output.length} record(s) stitched to a master patient; ${output.length - passed.length} held for review. ${auditCount} audit event(s) on chain.`,
    issues,
    output: passed
  };
}

/** Consent changes come from the patient, so they are recorded as their own audit event. */
export async function setConsent(healjourId: string, purpose: ConsentPurpose, granted: boolean) {
  const store = getStore();
  const patient = await store.getPatient(healjourId);
  if (!patient) return undefined;
  const existing = patient.consents.find(c => c.purpose === purpose);
  if (existing) { existing.granted = granted; existing.grantedAt = isoNow(); existing.expiresAt = undefined; }
  else patient.consents.push({ purpose, granted, grantedAt: isoNow() });
  await store.savePatient(patient);
  await recordAudit({ actor: "consent_admin", action: granted ? "consent.granted" : "consent.withdrawn", healjourId, detail: `Consent for ${purpose} set to ${granted}.` });
  return patient;
}

export const newCorrelationId = () => randomUUID();
