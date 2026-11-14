// Layer 02 - Normalization
// Schema mapping and validation. Takes RawRecord[] in the source's own shape and
// produces canonical records plus the FHIR R4 resources the modern sinks expect.
// Nothing here guesses: an unknown test code or unit is flagged, never converted.

import type {
  CanonicalObservation, CanonicalRecord, LayerIssue, LayerTrace, RawRecord
} from "./types.js";

/** Approved test catalog. Only codes listed here are allowed through without a flag. */
export const testCatalog = [
  { local: ["CBC", "HEMOGRAM", "CBC-01", "58410-2"], loinc: "58410-2", display: "CBC panel - Blood by Automated count" },
  { local: ["GLU", "GLUF", "FBS", "1558-6"], loinc: "1558-6", display: "Fasting glucose [Mass/volume] in Serum or Plasma" },
  { local: ["HBA1C", "A1C", "4548-4"], loinc: "4548-4", display: "Hemoglobin A1c/Hemoglobin.total in Blood" },
  { local: ["TSH", "3016-3"], loinc: "3016-3", display: "Thyrotropin [Units/volume] in Serum or Plasma" },
  { local: ["LIPID", "LIPID-PANEL", "57698-3"], loinc: "57698-3", display: "Lipid panel with direct LDL - Serum or Plasma" },
  { local: ["CREA", "CREAT", "2160-0"], loinc: "2160-0", display: "Creatinine [Mass/volume] in Serum or Plasma" },
  { local: ["VITD", "25OHD", "1989-3"], loinc: "1989-3", display: "Vitamin D 25-Hydroxy [Mass/volume] in Serum or Plasma" },
  { local: ["HGB", "HB", "HAEMOGLOBIN", "718-7"], loinc: "718-7", display: "Hemoglobin [Mass/volume] in Blood" },
  { local: ["WBC", "TLC", "6690-2"], loinc: "6690-2", display: "Leukocytes [#/volume] in Blood by Automated count" },
  { local: ["PLT", "PLATELET", "777-3"], loinc: "777-3", display: "Platelets [#/volume] in Blood by Automated count" },
  { local: ["CHOL", "TCHOL", "2093-3"], loinc: "2093-3", display: "Cholesterol [Mass/volume] in Serum or Plasma" }
];

/** Units the pipeline recognises, with the canonical UCUM form it maps to. */
const unitMap: Record<string, string> = {
  "mg/dl": "mg/dL", "mgdl": "mg/dL", "mg%": "mg/dL",
  "g/dl": "g/dL", "gm/dl": "g/dL",
  "mmol/l": "mmol/L", "miu/l": "mIU/L", "uiu/ml": "uIU/mL",
  "ng/ml": "ng/mL", "pg/ml": "pg/mL",
  "%": "%", "ratio": "1",
  "10^3/ul": "10*3/uL", "103/ul": "10*3/uL", "k/ul": "10*3/uL",
  "10^6/ul": "10*6/uL", "cells/ul": "/uL"
};

const statusMap: Record<string, CanonicalObservation["status"]> = {
  f: "final", final: "final", approved: "final", authorised: "final", authorized: "final", y: "final", complete: "final", completed: "final",
  p: "preliminary", preliminary: "preliminary", pending: "preliminary", partial: "preliminary", n: "preliminary",
  c: "corrected", corrected: "corrected", amended: "corrected",
  x: "entered-in-error", cancelled: "entered-in-error", canceled: "entered-in-error", error: "entered-in-error"
};

const priorityMap: Record<string, "routine" | "urgent" | "stat"> = {
  r: "routine", routine: "routine", normal: "routine",
  a: "urgent", urgent: "urgent", asap: "urgent", high: "urgent",
  s: "stat", stat: "stat", emergency: "stat"
};

const genderMap: Record<string, "male" | "female" | "other" | "unknown"> = {
  m: "male", male: "male", f: "female", female: "female", o: "other", other: "other"
};

const pick = (fields: Record<string, string>, keys: string[]) => {
  for (const key of keys) {
    const hit = Object.keys(fields).find(k => k.toLowerCase() === key.toLowerCase());
    const value = hit ? fields[hit]?.trim() : "";
    if (value) return value;
  }
  return undefined;
};

/** Accepts ISO, HL7 (YYYYMMDD[HHMMSS]) and dd/MM/yyyy. Returns ISO or undefined. */
export function normalizeDate(value?: string): string | undefined {
  if (!value) return undefined;
  const raw = value.trim();
  if (/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(raw)) {
    const parsed = new Date(raw.length === 10 ? `${raw}T00:00:00Z` : raw);
    return Number.isNaN(parsed.getTime()) ? undefined : (raw.length === 10 ? raw : parsed.toISOString());
  }
  const hl7 = raw.match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?/);
  if (hl7) {
    const [, y, m, d, hh, mm, ss] = hl7;
    if (!hh) return `${y}-${m}-${d}`;
    const parsed = new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss ?? "00"}Z`);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  const dmy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return undefined;
}

export function mapTestCode(code?: string) {
  if (!code) return undefined;
  const needle = code.trim().toUpperCase();
  return testCatalog.find(entry => entry.local.some(l => l.toUpperCase() === needle));
}

export function normalizeUnit(unit?: string) {
  if (!unit) return { unit: undefined, known: true };
  const cleaned = unit.trim();
  const mapped = unitMap[cleaned.toLowerCase()];
  return { unit: mapped ?? cleaned, known: Boolean(mapped) };
}

export type NormalizationOptions = {
  rejectUnknownTestCodes: boolean;
  validateDates: boolean;
  requireApprovedResults: boolean;
};

export const defaultNormalizationOptions: NormalizationOptions = {
  rejectUnknownTestCodes: true,
  validateDates: true,
  requireApprovedResults: true
};

function normalizeRecord(raw: RawRecord, options: NormalizationOptions, issues: LayerIssue[]): CanonicalRecord {
  const f = raw.fields;
  const birthDate = normalizeDate(pick(f, ["PID.7", "Patient.birthDate", "birth_date", "dob", "DOB", "BIRTH_DATE"]));
  const orderedAtRaw = pick(f, ["OBR.7", "ServiceRequest.authoredOn", "ordered_at", "OrderDate", "ORDER_DATE"]);
  const orderedAt = normalizeDate(orderedAtRaw);
  if (options.validateDates && orderedAtRaw && !orderedAt) {
    issues.push({ layer: "normalization", code: "unparsable_date", severity: "error", recordId: raw.recordId, message: `Order date "${orderedAtRaw}" does not match an agreed format; the record is held rather than guessed.` });
  }

  const genderRaw = pick(f, ["PID.8", "Patient.gender", "gender", "sex", "SEX"]);
  const priorityRaw = pick(f, ["OBR.5", "ServiceRequest.priority", "priority", "Priority", "PRIORITY"]);
  const codeRaw = pick(f, ["OBR.4.1", "ServiceRequest.code", "test_code", "InvestigationCode", "TEST_CODE"]);
  const mapped = mapTestCode(codeRaw);
  if (codeRaw && !mapped) {
    issues.push({
      layer: "normalization", code: "unknown_test_code",
      severity: options.rejectUnknownTestCodes ? "error" : "warning", recordId: raw.recordId,
      message: `Test code "${codeRaw}" has no approved catalog mapping, so the record is ${options.rejectUnknownTestCodes ? "quarantined" : "passed with a flag"}.`
    });
  }

  const observations: CanonicalObservation[] = raw.results.map(result => {
    const obsCodeRaw = result.code?.trim();
    const obsMapped = mapTestCode(obsCodeRaw);
    if (obsCodeRaw && !obsMapped) {
      issues.push({
        layer: "normalization", code: "unknown_result_code",
        severity: options.rejectUnknownTestCodes ? "error" : "warning", recordId: raw.recordId,
        message: `Result code "${obsCodeRaw}" is not in the approved catalog.`
      });
    }
    const { unit, known } = normalizeUnit(result.unit);
    if (unit && !known) {
      issues.push({
        layer: "normalization", code: "unknown_unit", severity: "error", recordId: raw.recordId,
        message: `Unit "${result.unit}" is not in the approved unit map. The value is carried through unconverted and flagged.`
      });
    }
    const statusRaw = (result.status ?? "").trim().toLowerCase();
    const status = statusMap[statusRaw] ?? "preliminary";
    if (statusRaw && !statusMap[statusRaw]) {
      issues.push({ layer: "normalization", code: "unknown_result_status", severity: "warning", recordId: raw.recordId, message: `Result status "${result.status}" is unmapped; it is treated as preliminary.` });
    }
    if (options.requireApprovedResults && status !== "final" && status !== "corrected") {
      issues.push({ layer: "normalization", code: "result_not_approved", severity: "warning", recordId: raw.recordId, message: `Result ${obsCodeRaw ?? ""} is ${status}; it will not be published as final.` });
    }
    const numeric = Number(result.value);
    const flag = (result.interpretation ?? "").trim().toUpperCase();
    return {
      code: obsMapped?.loinc ?? obsCodeRaw ?? "",
      display: obsMapped?.display ?? result.display ?? obsCodeRaw ?? "",
      value: result.value?.trim() || undefined,
      valueQuantity: result.value?.trim() && !Number.isNaN(numeric) ? numeric : undefined,
      unit,
      referenceRange: result.referenceRange?.trim() || undefined,
      interpretation: (["N", "H", "L", "A"] as const).includes(flag as any) ? (flag as "N" | "H" | "L" | "A") : undefined,
      status,
      issuedAt: normalizeDate(result.issued)
    };
  });

  return {
    recordId: raw.recordId,
    kind: raw.kind,
    patient: {
      mrn: pick(f, ["PID.3", "Patient.identifier", "patient_ref", "PatientCode", "PATIENT_ID"]),
      nationalId: pick(f, ["national_id", "NATIONAL_ID", "abha_id"]),
      familyName: pick(f, ["PID.5.1", "Patient.family", "last_name", "family_name", "LAST_NAME"]),
      givenName: pick(f, ["PID.5.2", "Patient.given", "first_name", "given_name", "FIRST_NAME"]),
      birthDate,
      gender: genderMap[(genderRaw ?? "").trim().toLowerCase()] ?? "unknown",
      phone: pick(f, ["PID.13", "Patient.telecom", "phone", "mobile", "MOBILE"])
    },
    order: {
      placerOrderId: pick(f, ["OBR.2", "ServiceRequest.id", "order_id", "LabOrderRef", "ORDER_NO"]),
      fillerOrderId: pick(f, ["OBR.3", "ServiceRequest.requisition", "filler_order_id", "FILLER_ORDER_NO"]),
      accessionNumber: pick(f, ["OBR.3", "accession_number", "AccessionNo", "ACCESSION_NO"]),
      code: mapped?.loinc ?? codeRaw,
      display: mapped?.display ?? pick(f, ["OBR.4.2", "ServiceRequest.display", "test_name", "InvestigationName", "TEST_NAME"]) ?? codeRaw,
      priority: priorityMap[(priorityRaw ?? "").trim().toLowerCase()] ?? "routine",
      orderedAt
    },
    observations,
    source: raw.source
  };
}

/** Minimum identity a record needs before any downstream layer may touch it. */
function validateCanonical(record: CanonicalRecord, issues: LayerIssue[]) {
  if (!record.patient.mrn && !record.patient.nationalId && !record.patient.phone) {
    issues.push({ layer: "normalization", code: "no_patient_identifier", severity: "error", recordId: record.recordId, message: "Record carries no MRN, national ID or phone number, so it cannot be safely attributed to a patient." });
  }
  if (!record.order.placerOrderId && !record.order.fillerOrderId && !record.order.accessionNumber) {
    issues.push({ layer: "normalization", code: "no_order_identifier", severity: "error", recordId: record.recordId, message: "Record carries no order or accession identifier." });
  }
  if (record.kind === "result" && !record.observations.length) {
    issues.push({ layer: "normalization", code: "result_without_values", severity: "error", recordId: record.recordId, message: "Record is typed as a result but carries no observation values." });
  }
  for (const obs of record.observations) {
    if (obs.valueQuantity != null && !obs.unit) {
      issues.push({ layer: "normalization", code: "numeric_without_unit", severity: "warning", recordId: record.recordId, message: `Observation ${obs.code} has a numeric value with no unit.` });
    }
  }
}

/** FHIR R4 projection handed to the modern sinks. */
export function toFhirBundle(record: CanonicalRecord) {
  const patientId = `pat-${record.recordId}`;
  const requestId = `req-${record.recordId}`;
  const entry: Array<{ resource: Record<string, unknown> }> = [
    {
      resource: {
        resourceType: "Patient", id: patientId,
        identifier: [
          record.patient.mrn ? { system: "urn:healjour:mrn", value: record.patient.mrn } : undefined,
          record.patient.nationalId ? { system: "urn:healjour:national-id", value: record.patient.nationalId } : undefined
        ].filter(Boolean),
        name: [{ family: record.patient.familyName, given: [record.patient.givenName].filter(Boolean) }],
        telecom: record.patient.phone ? [{ system: "phone", value: record.patient.phone }] : undefined,
        gender: record.patient.gender,
        birthDate: record.patient.birthDate
      }
    },
    {
      resource: {
        resourceType: "ServiceRequest", id: requestId,
        status: record.kind === "result" ? "completed" : "active",
        intent: "order",
        priority: record.order.priority,
        code: { coding: [{ system: "http://loinc.org", code: record.order.code, display: record.order.display }] },
        subject: { reference: `Patient/${patientId}` },
        requisition: record.order.accessionNumber ? { value: record.order.accessionNumber } : undefined,
        authoredOn: record.order.orderedAt
      }
    }
  ];

  record.observations.forEach((obs, i) => {
    entry.push({
      resource: {
        resourceType: "Observation", id: `obs-${record.recordId}-${i + 1}`,
        status: obs.status,
        basedOn: [{ reference: `ServiceRequest/${requestId}` }],
        subject: { reference: `Patient/${patientId}` },
        code: { coding: [{ system: "http://loinc.org", code: obs.code, display: obs.display }] },
        valueQuantity: obs.valueQuantity != null ? { value: obs.valueQuantity, unit: obs.unit, system: "http://unitsofmeasure.org", code: obs.unit } : undefined,
        valueString: obs.valueQuantity == null ? obs.value : undefined,
        interpretation: obs.interpretation ? [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", code: obs.interpretation }] }] : undefined,
        referenceRange: obs.referenceRange ? [{ text: obs.referenceRange }] : undefined,
        issued: obs.issuedAt
      }
    });
  });

  return { resourceType: "Bundle", type: "collection", id: `bundle-${record.recordId}`, entry };
}

export function runNormalization(records: RawRecord[], options: NormalizationOptions = defaultNormalizationOptions): LayerTrace<CanonicalRecord[]> {
  const started = Date.now();
  const issues: LayerIssue[] = [];
  const canonical = records.map(raw => {
    const record = normalizeRecord(raw, options, issues);
    validateCanonical(record, issues);
    return record;
  });

  const blocked = new Set(issues.filter(i => i.severity === "error" && i.recordId).map(i => i.recordId));
  const passed = canonical.filter(record => !blocked.has(record.recordId));
  const errors = issues.filter(i => i.severity === "error");

  return {
    layer: "normalization",
    title: "Normalization",
    status: passed.length === 0 && canonical.length > 0 ? "failed" : errors.length ? "passed_with_warnings" : issues.length ? "passed_with_warnings" : "passed",
    durationMs: Date.now() - started,
    summary: `${passed.length} of ${canonical.length} record(s) normalized to FHIR R4; ${blocked.size} quarantined by mapping or validation rules.`,
    issues,
    output: passed
  };
}
