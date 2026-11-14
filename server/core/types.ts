// Canonical shapes shared by the four Healjour Core layers.
// Sources speak HL7v2 / FHIR / CSV / JDBC; everything past the Connector Mesh
// speaks these types, and the Normalization layer emits FHIR R4 resources.

export type SourceFormat = "hl7v2" | "fhir" | "csv" | "jdbc";
export type Transport = "sftp" | "https" | "jdbc" | "mllp" | "local_folder";
export type RecordKind = "order" | "result";

/** One record as the Connector Mesh read it, still in the source's own shape. */
export type RawRecord = {
  recordId: string;
  kind: RecordKind;
  /** Flat key/value view of the source record, keys as the source named them. */
  fields: Record<string, string>;
  /** Result rows carried by the record (HL7 OBX, FHIR Observation, CSV result columns). */
  results: Array<Record<string, string>>;
  source: { connectorId: string; format: SourceFormat; transport: Transport; receivedAt: string };
};

export type CanonicalPatient = {
  mrn?: string;
  nationalId?: string;
  familyName?: string;
  givenName?: string;
  birthDate?: string;
  gender?: "male" | "female" | "other" | "unknown";
  phone?: string;
};

export type CanonicalObservation = {
  code: string;
  display: string;
  value?: string;
  valueQuantity?: number;
  unit?: string;
  referenceRange?: string;
  interpretation?: "N" | "H" | "L" | "A";
  status: "registered" | "preliminary" | "final" | "corrected" | "entered-in-error";
  issuedAt?: string;
};

export type CanonicalRecord = {
  recordId: string;
  kind: RecordKind;
  patient: CanonicalPatient;
  order: {
    placerOrderId?: string;
    fillerOrderId?: string;
    accessionNumber?: string;
    code?: string;
    display?: string;
    priority?: "routine" | "urgent" | "stat";
    orderedAt?: string;
  };
  observations: CanonicalObservation[];
  source: RawRecord["source"];
};

export type Severity = "info" | "warning" | "error";
export type LayerIssue = { layer: LayerId; code: string; severity: Severity; message: string; recordId?: string };
export type LayerId = "connector_mesh" | "normalization" | "identity_consent" | "orchestration";

export type LayerTrace<T> = {
  layer: LayerId;
  title: string;
  status: "passed" | "passed_with_warnings" | "failed";
  durationMs: number;
  summary: string;
  issues: LayerIssue[];
  output: T;
};

export const isoNow = () => new Date().toISOString();
