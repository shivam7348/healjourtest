// Documents that outlive a request. Each type here maps to one MongoDB collection
// and is kept free of imports from the layer modules so the store can be shared
// without a cycle.

import type { CanonicalPatient } from "./types.js";

export type ConsentPurpose = "treatment" | "underwriting" | "claims" | "marketplace" | "wellness" | "research";

/** Collection: patients. _id is healjourId. */
export type MasterPatient = {
  healjourId: string;
  mrns: string[];
  nationalId?: string;
  phones: string[];
  familyName?: string;
  givenName?: string;
  birthDate?: string;
  gender?: CanonicalPatient["gender"];
  consents: Array<{ purpose: ConsentPurpose; granted: boolean; grantedAt: string; expiresAt?: string }>;
  createdAt: string;
  lastSeenAt: string;
};

/** Collection: audit. Append-only; _id is seq. */
export type AuditEvent = {
  seq: number;
  at: string;
  actor: string;
  action: string;
  recordId?: string;
  healjourId?: string;
  detail: string;
  previousHash: string;
  hash: string;
};

export type DeliveryAttempt = {
  attempt: number;
  at: string;
  outcome: "delivered" | "retrying" | "failed";
  latencyMs: number;
  detail: string;
};

/** Collection: deadLetters. _id is deliveryId. */
export type Delivery = {
  deliveryId: string;
  recordId: string;
  healjourId?: string;
  sinkId: string;
  sinkLabel: string;
  status: "delivered" | "dead_letter" | "skipped";
  reason?: string;
  attempts: DeliveryAttempt[];
  totalLatencyMs: number;
  slaMs: number;
  slaMet: boolean;
  payloadPreview: string;
};

/**
 * Healjour's own test catalog. Collection: catalogTests. _id is the Healjour code.
 * Other systems (Flabs, etc.) are mapped to these codes; they never define them.
 */
export type CatalogTest = {
  code: string;
  name: string;
  loinc?: string;
  sampleType?: string;
  unit?: string;
  referenceRange?: string;
  price: number;
  active: boolean;
  updatedAt: string;
  /** Pathology, Radiology, Cardiology, ... Missing means "detect from the name". */
  category?: string;
  subcategory?: string;
  /** "manual" when someone chose the category; detection never overrides it. */
  categorySource?: "auto" | "manual";
  /** Set when a Flabs sync created this test: which account and Flabs test it came from. */
  createdFrom?: { connectionId: string; flabsId: string; flabsCode: string };
};

/**
 * Collection: flabsMappings. _id is the Healjour test code. Written by the Flabs sync
 * (matching Flabs test `code` to Healjour code). Replaced wholesale on each sync.
 */
export type FlabsMapping = {
  connectionId: string;
  kind: "test" | "package";
  healjourCode: string;
  flabsId: string;
  flabsCode: string;
  flabsName: string;
  flabsCost: number;
  /** auto = matched by code during sync; manual = chosen by staff and kept across syncs. */
  source?: "auto" | "manual";
  syncedAt: string;
};

/**
 * Party a Flabs account is scoped to. Corporate, referring doctor and referring hospital
 * accounts must attach one of these to every lead, and get corporate-specific prices.
 */
export type FlabsParty = {
  field: "corporateUser" | "referredOrganization" | "referredHospitalOrganization";
  id: string;
};

/** Collection: flabsConnections. _id is the connection id. The client secret is sealed (AES-256-GCM). */
export type StoredFlabsConnection = {
  id: string;
  label: string;
  clientId: string;
  baseUrl: string;
  branchId: string;
  phase: "lead" | "booking";
  party?: FlabsParty;
  isDefault: boolean;
  secret: { iv: string; tag: string; data: string };
  /** Shared token in our webhook URL. Flabs posts events to /api/webhooks/flabs/<token>. */
  webhookToken?: string;
  updatedAt: string;
};

/**
 * Collection: integrationLogs. One row per external action (booking sent, sync run, account change,
 * pipeline delivery). Written in plain terms so the Logs screen can show it without decoding.
 */
export type IntegrationLog = {
  id: string;
  at: string;
  type: "booking" | "sync" | "account" | "delivery" | "webhook" | "lab_portal";
  status: "success" | "duplicate" | "error" | "info";
  account: string;
  title: string;
  message: string;
  integratorID?: string;
  leadId?: string;
  httpStatus?: number;
  details?: string[];
};

/** Collection: staff. Medical staff who can be assigned to a booking. */
export type StaffMember = {
  id: string;
  name: string;
  role: string;
  active: boolean;
};

/**
 * Collection: appointments. One per booking that has a time or needs one.
 * Created from the booking form; assigned to a staff member from the calendar.
 */
export type Appointment = {
  id: string;
  integratorID: string;
  leadId?: string;
  account: string;
  patientName: string;
  contact: string;
  tests: string[];
  bookingType?: string;
  address?: string;
  scheduledAt?: string;          // ISO time; absent means "not scheduled yet"
  staffId?: string;              // absent means "unassigned"
  status: "unassigned" | "assigned" | "done" | "cancelled";
  createdAt: string;
  updatedAt: string;
  // Filled from Flabs webhooks (tracker): latest Flabs event, bill, report link and test results.
  flabsEvent?: string;
  flabsEventAt?: string;
  billId?: string;
  reportUrl?: string;
  reportAt?: string;
  results?: FlabsTestResult[];
  sampleImages?: Array<{ url: string; lat: number | null; lng: number | null; capturedAt?: string }>;
  /** Who sent the booking (user ID + name; plus the Super Admin when sent via "Login as"). */
  creator?: { id: string; name: string; email: string; via?: { id: string; name: string; email: string } };
};

export type FlabsTestResult = {
  testName: string;
  status: string;
  parameters: Array<{ name: string; value: string }>;
};

/**
 * Collection: flabsPrebookingSettings. _id is the Flabs connection id.
 * Values Flabs gives each lab for pre-bookings, so staff pick them from a list instead of typing IDs.
 */
export type FlabsReferral = { id: string; name: string; flabsId: string };
export type FlabsPrebookingSettings = {
  connectionId: string;
  leadSources: string[];
  rateListTypes: string[];
  doctors: FlabsReferral[];
  hospitals: FlabsReferral[];
  /** When on, every Healjour booking sent to this lab account also creates a Flabs pre-booking. */
  autoPrebooking?: boolean;
  /** Used by auto pre-booking, since a booking does not carry a lead source or rate list. */
  defaultLeadSource?: string;
  defaultRateListType?: string;
  updatedAt: string;
};

/**
 * Collection: integrations. _id is the integration id. A CSV lab connection saved from the
 * Integration Studio wizard. Holds folder paths and rules only: never SFTP passwords or keys.
 */
export type StudioIntegration = {
  id: string;
  name: string;
  labCode: string;
  transport: "sftp" | "managed_gateway" | "local_folder";
  delimiter: string;
  pollingMinutes: number;
  direction: "both" | "outbound" | "inbound";
  outboundPath?: string;
  inboundPath?: string;
  validationRules: {
    requiredHeaders: boolean;
    rejectUnknownTestCodes: boolean;
    detectDuplicates: boolean;
    validateDates: boolean;
    requireApprovedResults: boolean;
    quarantinePatientMismatch: boolean;
  };
  status: "draft" | "tested";
  lastTest?: { passed: boolean; message: string; at: string };
  /** SHA-256 of imported result files, for "Detect duplicate records". Newest 200 kept. */
  seenChecksums?: string[];
  /** Last sandbox run of each step, for the screen. */
  activity?: {
    send?: { at: string; file: string; orders: number };
    lab?: { at: string; pickedUp: string[]; resultsFile: string | null; results: number };
    receive?: { at: string; files: number; imported: number; rejected: number; duplicates: number };
  };
  createdAt: string;
  updatedAt: string;
};

/** Collection: catalogPackages. _id is the Healjour code. Packages are lists of catalog test codes. */
export type CatalogPackage = {
  code: string;
  name: string;
  testCodes: string[];
  price: number;
  active: boolean;
  updatedAt: string;
};

/** Collection: runs. _id is runId. */
export type PipelineRun = {
  runId: string;
  startedAt: string;
  connectorId: string;
  recordCount: number;
  delivered: number;
  deadLettered: number;
  skipped: number;
  slaBreaches: number;
  durationMs: number;
};

export type LabAccessStatus = "pending" | "approved" | "rejected";
export type CredentialStatus = "not_created" | "active" | "revoked";

/** Collection: partnerLabs. _id is the lab id. Holds a derived verifier, never a secret. */
export type PartnerLab = {
  id: string;
  name: string;
  labCode: string;
  status: LabAccessStatus;
  requestedAt: string;
  reviewedAt?: string;
  credentialStatus: CredentialStatus;
  clientId?: string;
  secretHash?: string;
  scopes: string[];
  createdAt?: string;
  rotatedAt?: string;
  revokedAt?: string;
  version: number;
};

/** Collection: accessTokens. _id is the SHA-256 of the token; expires via a TTL index. */
export type IssuedToken = {
  tokenHash: string;
  labId: string;
  scopes: string[];
  expiresAt: Date;
};
