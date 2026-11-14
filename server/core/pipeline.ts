// Runs a payload through all four Healjour Core layers and returns a per-layer trace.
// A layer that fails stops the pipeline: nothing downstream sees a record the layer
// above it refused to pass.

import { randomUUID } from "node:crypto";
import { connectorCatalog, findConnector, runConnectorMesh, writeBack } from "./connectors.js";
import { defaultNormalizationOptions, runNormalization, toFhirBundle } from "./normalization.js";
import type { NormalizationOptions } from "./normalization.js";
import { runIdentityAndConsent } from "./identity.js";
import { runOrchestration, sinkCatalog } from "./orchestration.js";
import type { FailureMode } from "./orchestration.js";
import type { CanonicalRecord, LayerIssue, LayerTrace } from "./types.js";
import { isoNow } from "./types.js";

export type PipelineRequest = {
  connectorId: string;
  payload: string;
  delimiter?: string;
  sinks: string[];
  /** Flabs accounts to send to; omit for all connected accounts. */
  flabsConnectionIds?: string[];
  failureMode?: FailureMode;
  normalization?: Partial<NormalizationOptions>;
  quarantineOnAmbiguity?: boolean;
};

export async function runPipeline(request: PipelineRequest) {
  const runId = `run-${randomUUID().slice(0, 8)}`;
  const startedAt = isoNow();
  const traces: Array<LayerTrace<unknown>> = [];

  const mesh = runConnectorMesh({ connectorId: request.connectorId, payload: request.payload, delimiter: request.delimiter });
  traces.push(mesh);
  if (mesh.status === "failed") return finish(runId, startedAt, request, traces, [], []);

  const normalization = runNormalization(mesh.output, { ...defaultNormalizationOptions, ...request.normalization });
  traces.push(normalization);
  if (normalization.status === "failed") return finish(runId, startedAt, request, traces, [], []);

  const identity = await runIdentityAndConsent(normalization.output, {
    requestedSinks: request.sinks,
    quarantineOnAmbiguity: request.quarantineOnAmbiguity ?? true
  });
  traces.push(identity);
  if (identity.status === "failed") return finish(runId, startedAt, request, traces, [], []);

  const orchestration = await runOrchestration(identity.output, {
    runId, connectorId: request.connectorId, requestedSinks: request.sinks,
    failureMode: request.failureMode ?? "auto",
    flabsConnectionIds: request.flabsConnectionIds
  });
  traces.push(orchestration);

  return finish(runId, startedAt, request, traces, identity.output.map(o => o.record), orchestration.output.deliveries, identity.output.map(o => o.decision));
}

function finish(
  runId: string,
  startedAt: string,
  request: PipelineRequest,
  traces: Array<LayerTrace<unknown>>,
  records: CanonicalRecord[],
  deliveries: unknown[],
  decisions: unknown[] = []
) {
  const issues = traces.flatMap(t => t.issues) as LayerIssue[];
  const stoppedAt = traces.find(t => t.status === "failed");
  return {
    runId,
    startedAt,
    completedAt: isoNow(),
    connector: findConnector(request.connectorId)?.label ?? request.connectorId,
    status: stoppedAt ? "stopped" : issues.some(i => i.severity === "error") ? "completed_with_issues" : "completed",
    stoppedAtLayer: stoppedAt?.layer,
    layers: traces,
    canonical: records,
    fhir: records.map(toFhirBundle),
    writeBack: records.slice(0, 1).map(record => writeBack(request.connectorId, record)),
    identityDecisions: decisions,
    deliveries,
    counts: {
      errors: issues.filter(i => i.severity === "error").length,
      warnings: issues.filter(i => i.severity === "warning").length,
      info: issues.filter(i => i.severity === "info").length
    }
  };
}

/** Shape of the Sources -> Core -> Sinks picture, served so the UI never hardcodes it. */
export const coreTopology = {
  sources: [
    { id: "pathology_labs", label: "Pathology Labs", detail: "8,400+ centers", connectors: ["path-csv-results"] },
    { id: "diagnostic_centres", label: "Diagnostic Centers", detail: "Imaging & path", connectors: ["diag-fhir-r4"] },
    { id: "hospital_lis", label: "Hospital LIMS", detail: "HL7 v2 / DICOM", connectors: ["lis-hl7v2-oru", "lis-jdbc-poll"] }
  ],
  layers: [
    { id: "connector_mesh", index: "01", title: "Connector Mesh", subtitle: "HL7v2, FHIR, CSV, JDBC, SFTP", detail: "Typed, bi-directional adapters that read each legacy system in its own dialect." },
    { id: "normalization", index: "02", title: "Normalization", subtitle: "Schema mapping & validation", detail: "Maps source fields to canonical records and FHIR R4, flagging anything it cannot map." },
    { id: "identity_consent", index: "03", title: "Identity & Consent", subtitle: "Patient stitch + audit", detail: "Resolves the patient against a master index, enforces consent, writes a hash-chained audit trail." },
    { id: "orchestration", index: "04", title: "Orchestration", subtitle: "Routing, retries, SLAs", detail: "Routes to each sink, retries with backoff, measures SLA, dead-letters the rest." }
  ],
  sinks: sinkCatalog.map(s => ({ id: s.id, label: s.label, category: s.category, detail: s.description, slaMs: s.slaMs })),
  connectors: connectorCatalog
};

export const samplePayloads: Record<string, { connectorId: string; label: string; payload: string }> = {
  hl7_oru: {
    connectorId: "lis-hl7v2-oru",
    label: "HL7 v2 ORU^R01 - final CBC and glucose",
    payload: [
      "MSH|^~\\&|LIS|CITY-HOSP|HEALJOUR|HEALJOUR|20261020094500||ORU^R01|MSG00219|P|2.5",
      "PID|1||MRN-88421^^^CITY^MR||Sharma^Anil||19790412|M|||||9810012345",
      "OBR|1|ORD-55120|ACC-77231|CBC^Complete Blood Count|R||20261020083000|||||||||||||||20261020093000|||F",
      "OBX|1|NM|HGB^Hemoglobin||13.8|g/dL|13.0-17.0|N|||F|||20261020093000",
      "OBX|2|NM|GLU^Fasting glucose||104|mg/dL|70-100|H|||F|||20261020093000"
    ].join("\n")
  },
  fhir_bundle: {
    connectorId: "diag-fhir-r4",
    label: "FHIR R4 bundle - HbA1c result",
    payload: JSON.stringify({
      resourceType: "Bundle", type: "transaction", id: "bdl-4471",
      entry: [
        { resource: { resourceType: "Patient", identifier: [{ value: "MRN-90733" }], name: [{ family: "Iyer", given: ["Meera"] }], birthDate: "1991-11-30", gender: "female", telecom: [{ system: "phone", value: "9999001122" }] } },
        { resource: { resourceType: "ServiceRequest", id: "sr-9001", status: "active", intent: "order", priority: "routine", code: { coding: [{ code: "HBA1C", display: "HbA1c" }] }, authoredOn: "2026-10-18T06:30:00Z" } },
        { resource: { resourceType: "Observation", id: "obs-1", status: "final", basedOn: [{ reference: "ServiceRequest/sr-9001" }], code: { coding: [{ code: "HBA1C", display: "HbA1c" }] }, valueQuantity: { value: 5.6, unit: "%" }, interpretation: [{ coding: [{ code: "N" }] }], issued: "2026-10-18T11:05:00Z" } }
      ]
    }, null, 2)
  },
  csv_results: {
    connectorId: "path-csv-results",
    label: "CSV export - two rows, one unmapped test code",
    payload: [
      "order_id,patient_ref,first_name,last_name,dob,sex,mobile,test_code,result_value,unit,reference_range,approval_status,resulted_at",
      "ORD-77301,MRN-88421,Anil,Sharma,12/04/1979,M,9810012345,TSH,2.41,uIU/mL,0.4-4.0,Approved,20/10/2026",
      "ORD-77302,MRN-55099,Rahul,Verma,03/09/1988,M,9876500011,ZZTEST,18,mg/dL,-,Approved,20/10/2026"
    ].join("\n")
  },
  jdbc_rows: {
    connectorId: "lis-jdbc-poll",
    label: "JDBC poll - pending order row",
    payload: JSON.stringify([
      { ORDER_NO: "ORD-99001", PATIENT_ID: "MRN-11002", FIRST_NAME: "Anita", LAST_NAME: "Sharma", DOB: "19790412", SEX: "F", TEST_CODE: "LIPID", PRIORITY: "ASAP", ORDER_DATE: "20261021071500" }
    ], null, 2)
  },
  ambiguous_identity: {
    connectorId: "path-csv-results",
    label: "CSV export - demographic-only row that must not be auto-merged",
    payload: [
      "order_id,patient_ref,first_name,last_name,dob,sex,test_code,result_value,unit,approval_status,resulted_at",
      "ORD-77400,TEMP-0004,A.,Sharma,12/04/1979,,CREA,0.9,mg/dL,Approved,21/10/2026"
    ].join("\n")
  }
};
