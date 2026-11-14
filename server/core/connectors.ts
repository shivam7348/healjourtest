// Layer 01 - Connector Mesh
// Wraps a legacy system with a typed, bi-directional adapter. Each adapter reads the
// source's native payload into RawRecord[] and can write a canonical record back out
// in the source's own dialect, so the lab never changes its daily workflow.

import { randomUUID } from "node:crypto";
import type { CanonicalRecord, LayerIssue, LayerTrace, RawRecord, SourceFormat, Transport } from "./types.js";
import { isoNow } from "./types.js";

export type ConnectorDefinition = {
  id: string;
  label: string;
  sourceSystem: string;
  category: "pathology_lab" | "diagnostic_centre" | "hospital_lis";
  format: SourceFormat;
  transports: Transport[];
  direction: "inbound" | "outbound" | "both";
  /** Keys the adapter needs present on every record before it will hand it onward. */
  requiredFields: string[];
  description: string;
};

export const connectorCatalog: ConnectorDefinition[] = [
  {
    id: "lis-hl7v2-oru", label: "Hospital LIS - HL7 v2 results", sourceSystem: "Hospital LIS",
    category: "hospital_lis", format: "hl7v2", transports: ["mllp", "sftp"], direction: "both",
    requiredFields: ["MSH.10", "PID.3", "OBR.3"],
    description: "ORU^R01 result messages and ORM^O01 orders over MLLP or dropped as files."
  },
  {
    id: "path-csv-results", label: "Pathology Lab - delimited export", sourceSystem: "Pathology Labs",
    category: "pathology_lab", format: "csv", transports: ["sftp", "local_folder"], direction: "both",
    requiredFields: ["order_id", "patient_ref"],
    description: "Scheduled CSV drops of orders and results from an on-premise LIS."
  },
  {
    id: "diag-fhir-r4", label: "Diagnostic Centre - FHIR R4 bundle", sourceSystem: "Diagnostic Centres",
    category: "diagnostic_centre", format: "fhir", transports: ["https"], direction: "both",
    requiredFields: ["Bundle.entry"],
    description: "Transaction bundles containing Patient, ServiceRequest and Observation resources."
  },
  {
    id: "lis-jdbc-poll", label: "Hospital LIS - JDBC view", sourceSystem: "Hospital LIS",
    category: "hospital_lis", format: "jdbc", transports: ["jdbc"], direction: "inbound",
    requiredFields: ["ORDER_NO", "PATIENT_ID"],
    description: "Read-only polling of a reporting view when the LIS exposes no interface."
  }
];

export const findConnector = (id: string) => connectorCatalog.find(c => c.id === id);

const field = (row: Record<string, string>, ...keys: string[]) => {
  for (const key of keys) {
    const hit = Object.keys(row).find(k => k.toLowerCase() === key.toLowerCase());
    if (hit && row[hit]?.trim()) return row[hit].trim();
  }
  return undefined;
};

/** HL7 v2 pipe-delimited message to RawRecord[]. One record per OBR group. */
function parseHl7(payload: string, issues: LayerIssue[]): RawRecord[] {
  const segments = payload.split(/\r\n|\r|\n/).map(s => s.trim()).filter(Boolean).map(s => s.split("|"));
  const msh = segments.find(s => s[0] === "MSH");
  const pid = segments.find(s => s[0] === "PID");
  if (!msh) {
    issues.push({ layer: "connector_mesh", code: "hl7_missing_msh", severity: "error", message: "Message has no MSH segment; it is not a readable HL7 v2 message." });
    return [];
  }
  if (!pid) issues.push({ layer: "connector_mesh", code: "hl7_missing_pid", severity: "error", message: "Message has no PID segment; patient identity cannot be read." });

  // MSH is special: the field separator itself is MSH.1, so MSH.n sits at index n - 1.
  const messageType = msh[8] ?? "";
  const kind = messageType.startsWith("ORM") || messageType.startsWith("OMG") ? "order" as const : "result" as const;
  const pidName = (pid?.[5] ?? "").split("^");
  const base: Record<string, string> = {
    "MSH.9": messageType, "MSH.10": msh[9] ?? "",
    "PID.3": (pid?.[3] ?? "").split("^")[0] ?? "",
    "PID.5.1": pidName[0] ?? "", "PID.5.2": pidName[1] ?? "",
    "PID.7": pid?.[7] ?? "", "PID.8": pid?.[8] ?? "", "PID.13": (pid?.[13] ?? "").split("^")[0] ?? ""
  };

  const records: RawRecord[] = [];
  let current: RawRecord | null = null;
  for (const seg of segments) {
    if (seg[0] === "OBR") {
      const code = (seg[4] ?? "").split("^");
      current = {
        recordId: `${base["MSH.10"] || randomUUID().slice(0, 8)}-${seg[1] || records.length + 1}`,
        kind,
        fields: {
          ...base, "OBR.2": seg[2] ?? "", "OBR.3": seg[3] ?? "", "OBR.4.1": code[0] ?? "",
          "OBR.4.2": code[1] ?? "", "OBR.5": seg[5] ?? "", "OBR.7": seg[7] ?? "", "OBR.25": seg[25] ?? ""
        },
        results: [],
        source: { connectorId: "lis-hl7v2-oru", format: "hl7v2", transport: "mllp", receivedAt: isoNow() }
      };
      records.push(current);
    } else if (seg[0] === "OBX") {
      const code = (seg[3] ?? "").split("^");
      if (!current) {
        issues.push({ layer: "connector_mesh", code: "hl7_orphan_obx", severity: "warning", message: "An OBX segment appeared before any OBR and was dropped." });
        continue;
      }
      current.results.push({
        code: code[0] ?? "", display: code[1] ?? "", value: seg[5] ?? "", unit: seg[6] ?? "",
        referenceRange: seg[7] ?? "", interpretation: seg[8] ?? "", status: seg[11] ?? "", issued: seg[14] ?? ""
      });
    }
  }
  if (!records.length) issues.push({ layer: "connector_mesh", code: "hl7_no_obr", severity: "error", message: "Message carried no OBR segment, so there is nothing to route." });
  return records;
}

/** FHIR R4 Bundle to RawRecord[]. */
function parseFhir(payload: string, issues: LayerIssue[]): RawRecord[] {
  let bundle: any;
  try {
    bundle = JSON.parse(payload);
  } catch {
    issues.push({ layer: "connector_mesh", code: "fhir_invalid_json", severity: "error", message: "Payload is not valid JSON, so the FHIR bundle cannot be read." });
    return [];
  }
  if (bundle?.resourceType !== "Bundle" || !Array.isArray(bundle.entry)) {
    issues.push({ layer: "connector_mesh", code: "fhir_not_a_bundle", severity: "error", message: "Expected a FHIR Bundle with an entry array." });
    return [];
  }
  const resources = bundle.entry.map((e: any) => e?.resource).filter(Boolean);
  const patient = resources.find((r: any) => r.resourceType === "Patient");
  const requests = resources.filter((r: any) => r.resourceType === "ServiceRequest");
  const observations = resources.filter((r: any) => r.resourceType === "Observation");
  if (!patient) issues.push({ layer: "connector_mesh", code: "fhir_missing_patient", severity: "error", message: "Bundle contains no Patient resource." });

  const name = patient?.name?.[0] ?? {};
  const base: Record<string, string> = {
    "Bundle.entry": String(resources.length),
    "Patient.identifier": patient?.identifier?.[0]?.value ?? "",
    "Patient.family": name.family ?? "",
    "Patient.given": (name.given ?? []).join(" "),
    "Patient.birthDate": patient?.birthDate ?? "",
    "Patient.gender": patient?.gender ?? "",
    "Patient.telecom": (patient?.telecom ?? []).find((t: any) => t.system === "phone")?.value ?? ""
  };
  const toResult = (obs: any) => ({
    code: obs.code?.coding?.[0]?.code ?? "",
    display: obs.code?.coding?.[0]?.display ?? obs.code?.text ?? "",
    value: obs.valueQuantity?.value != null ? String(obs.valueQuantity.value) : (obs.valueString ?? ""),
    unit: obs.valueQuantity?.unit ?? "",
    referenceRange: obs.referenceRange?.[0]?.text ?? "",
    interpretation: obs.interpretation?.[0]?.coding?.[0]?.code ?? "",
    status: obs.status ?? "",
    issued: obs.issued ?? ""
  });

  if (!requests.length) {
    // Results posted without an accompanying ServiceRequest still have to flow.
    if (!observations.length) return [];
    return [{
      recordId: bundle.id ?? randomUUID().slice(0, 8),
      kind: "result",
      fields: base,
      results: observations.map(toResult),
      source: { connectorId: "diag-fhir-r4", format: "fhir", transport: "https", receivedAt: isoNow() }
    }];
  }

  return requests.map((req: any) => {
    const reference = `ServiceRequest/${req.id}`;
    const linked = observations.filter((o: any) => (o.basedOn ?? []).some((b: any) => b.reference === reference));
    return {
      recordId: req.id ?? randomUUID().slice(0, 8),
      kind: (linked.length ? "result" : "order") as RawRecord["kind"],
      fields: {
        ...base,
        "ServiceRequest.id": req.id ?? "",
        "ServiceRequest.requisition": req.requisition?.value ?? "",
        "ServiceRequest.code": req.code?.coding?.[0]?.code ?? "",
        "ServiceRequest.display": req.code?.coding?.[0]?.display ?? req.code?.text ?? "",
        "ServiceRequest.priority": req.priority ?? "",
        "ServiceRequest.authoredOn": req.authoredOn ?? ""
      },
      results: linked.map(toResult),
      source: { connectorId: "diag-fhir-r4", format: "fhir", transport: "https", receivedAt: isoNow() }
    } as RawRecord;
  });
}

/** Delimited text to rows. Handles quoted cells and embedded delimiters. */
export function parseDelimited(payload: string, delimiter: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < payload.length; i++) {
    const ch = payload[i];
    if (quoted) {
      if (ch === '"' && payload[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [header, ...body] = rows.filter(r => r.some(c => c.trim()));
  if (!header) return [];
  return body.map(cells => Object.fromEntries(header.map((h, i) => [h.trim(), (cells[i] ?? "").trim()])));
}

function parseCsv(payload: string, delimiter: string, issues: LayerIssue[]): RawRecord[] {
  const rows = parseDelimited(payload, delimiter);
  if (!rows.length) {
    issues.push({ layer: "connector_mesh", code: "csv_empty", severity: "error", message: "File had a header but no data rows." });
    return [];
  }
  return rows.map((row, i) => {
    const value = field(row, "result_value", "ResultValue", "value");
    return {
      recordId: field(row, "order_id", "LabOrderRef", "OrderId") ?? `row-${i + 1}`,
      kind: value ? "result" as const : "order" as const,
      fields: row,
      results: value ? [{
        code: field(row, "test_code", "InvestigationCode") ?? "",
        display: field(row, "test_name", "InvestigationName") ?? "",
        value,
        unit: field(row, "unit", "Units") ?? "",
        referenceRange: field(row, "reference_range", "RefRange") ?? "",
        interpretation: field(row, "abnormal_flag", "Flag") ?? "",
        status: field(row, "approval_status", "Approved", "LabStatus") ?? "",
        issued: field(row, "resulted_at", "ResultDate") ?? ""
      }] : [],
      source: { connectorId: "path-csv-results", format: "csv" as const, transport: "sftp" as const, receivedAt: isoNow() }
    };
  });
}

/** JDBC result set posted as JSON rows. */
function parseJdbc(payload: string, issues: LayerIssue[]): RawRecord[] {
  let rows: any;
  try {
    rows = JSON.parse(payload);
  } catch {
    issues.push({ layer: "connector_mesh", code: "jdbc_invalid_json", severity: "error", message: "JDBC poll result must be a JSON array of rows." });
    return [];
  }
  if (!Array.isArray(rows)) {
    issues.push({ layer: "connector_mesh", code: "jdbc_not_array", severity: "error", message: "JDBC poll result must be a JSON array of rows." });
    return [];
  }
  return rows.map((row: Record<string, unknown>, i: number) => {
    const fields = Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, v == null ? "" : String(v)]));
    const value = field(fields, "RESULT_VALUE", "VALUE");
    return {
      recordId: field(fields, "ORDER_NO", "ORDER_ID") ?? `jdbc-${i + 1}`,
      kind: value ? "result" as const : "order" as const,
      fields,
      results: value ? [{
        code: field(fields, "TEST_CODE") ?? "", display: field(fields, "TEST_NAME") ?? "",
        value, unit: field(fields, "UOM", "UNIT") ?? "", referenceRange: field(fields, "REF_RANGE") ?? "",
        interpretation: field(fields, "ABNORMAL_FLAG") ?? "", status: field(fields, "STATUS") ?? "",
        issued: field(fields, "RESULTED_AT") ?? ""
      }] : [],
      source: { connectorId: "lis-jdbc-poll", format: "jdbc" as const, transport: "jdbc" as const, receivedAt: isoNow() }
    };
  });
}

export type ConnectorInput = { connectorId: string; payload: string; delimiter?: string };

export function runConnectorMesh(input: ConnectorInput): LayerTrace<RawRecord[]> {
  const started = Date.now();
  const issues: LayerIssue[] = [];
  const connector = findConnector(input.connectorId);

  if (!connector) {
    issues.push({ layer: "connector_mesh", code: "unknown_connector", severity: "error", message: `No connector is registered as "${input.connectorId}".` });
    return { layer: "connector_mesh", title: "Connector Mesh", status: "failed", durationMs: Date.now() - started, summary: "Unknown connector.", issues, output: [] };
  }

  let records: RawRecord[] = [];
  if (connector.format === "hl7v2") records = parseHl7(input.payload, issues);
  else if (connector.format === "fhir") records = parseFhir(input.payload, issues);
  else if (connector.format === "csv") records = parseCsv(input.payload, input.delimiter ?? ",", issues);
  else records = parseJdbc(input.payload, issues);

  for (const record of records) {
    record.source.connectorId = connector.id;
    record.source.transport = connector.transports[0];
    for (const required of connector.requiredFields) {
      if (!record.fields[required]?.trim()) {
        issues.push({
          layer: "connector_mesh", code: "missing_required_field", severity: "error", recordId: record.recordId,
          message: `${connector.label} requires ${required}, which is empty on this record.`
        });
      }
    }
  }

  const errors = issues.filter(i => i.severity === "error");
  return {
    layer: "connector_mesh",
    title: "Connector Mesh",
    status: errors.length ? "failed" : issues.length ? "passed_with_warnings" : "passed",
    durationMs: Date.now() - started,
    summary: `${records.length} record(s) read from ${connector.sourceSystem} over ${connector.transports[0].toUpperCase()} as ${connector.format.toUpperCase()}.`,
    issues,
    output: records
  };
}

/** Bi-directional half: render a canonical record back into the source's own dialect. */
export function writeBack(connectorId: string, record: CanonicalRecord): { format: SourceFormat; payload: string } {
  const connector = findConnector(connectorId);
  const format = connector?.format ?? "csv";
  if (format === "hl7v2") {
    const stamp = (record.order.orderedAt ?? isoNow()).replace(/[-:TZ.]/g, "").slice(0, 14);
    return {
      format,
      payload: [
        `MSH|^~\\&|HEALJOUR|HEALJOUR|${connector?.sourceSystem ?? "LAB"}|LAB|${stamp}||ORM^O01|${record.recordId}|P|2.5`,
        `PID|1||${record.patient.mrn ?? ""}^^^HEALJOUR^MR||${record.patient.familyName ?? ""}^${record.patient.givenName ?? ""}||${(record.patient.birthDate ?? "").replace(/-/g, "")}|${(record.patient.gender ?? "u")[0].toUpperCase()}`,
        `ORC|NW|${record.order.placerOrderId ?? record.recordId}`,
        `OBR|1|${record.order.placerOrderId ?? ""}|${record.order.fillerOrderId ?? ""}|${record.order.code ?? ""}^${record.order.display ?? ""}|${record.order.priority === "stat" ? "S" : "R"}||${stamp}`
      ].join("\n")
    };
  }
  if (format === "fhir") {
    return {
      format,
      payload: JSON.stringify({
        resourceType: "Bundle", type: "transaction", id: record.recordId,
        entry: [
          { resource: { resourceType: "Patient", identifier: [{ system: "urn:healjour:mrn", value: record.patient.mrn }], name: [{ family: record.patient.familyName, given: [record.patient.givenName] }], birthDate: record.patient.birthDate, gender: record.patient.gender } },
          { resource: { resourceType: "ServiceRequest", id: record.order.placerOrderId ?? record.recordId, status: "active", intent: "order", priority: record.order.priority ?? "routine", code: { coding: [{ code: record.order.code, display: record.order.display }] }, authoredOn: record.order.orderedAt } }
        ]
      }, null, 2)
    };
  }
  const header = ["order_id", "patient_ref", "test_code", "priority", "ordered_at"];
  const row = [record.order.placerOrderId ?? record.recordId, record.patient.mrn ?? "", record.order.code ?? "", record.order.priority ?? "routine", record.order.orderedAt ?? ""];
  return { format, payload: `${header.join(",")}\n${row.join(",")}` };
}
