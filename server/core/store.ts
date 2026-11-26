// Persistence for everything that outlives a request.
//
// MongoDB is the real store. If no server is reachable at startup the process falls
// back to an in-memory store with identical semantics so the demo still runs, and
// says so on /api/health - it never pretends a write was durable when it was not.

import { MongoClient, type Collection, type Db } from "mongodb";
import { scryptSync } from "node:crypto";
import dns from "node:dns";
import type { AuditEvent, Appointment, CatalogPackage, CatalogTest, Delivery, FlabsMapping, FlabsPrebookingSettings, IssuedToken, MasterPatient, PartnerLab, PipelineRun, StaffMember, StoredFlabsConnection, IntegrationLog, StudioIntegration } from "./models.js";

export type StoreKind = "mongodb" | "memory";

export interface Store {
  readonly kind: StoreKind;
  readonly detail: string;

  listPatients(): Promise<MasterPatient[]>;
  getPatient(healjourId: string): Promise<MasterPatient | undefined>;
  savePatient(patient: MasterPatient): Promise<void>;
  countPatients(): Promise<number>;

  appendAudit(event: AuditEvent): Promise<void>;
  lastAudit(): Promise<AuditEvent | undefined>;
  listAudit(limit: number): Promise<AuditEvent[]>;
  allAudit(): Promise<AuditEvent[]>;
  countAudit(): Promise<number>;

  addDeadLetter(delivery: Delivery): Promise<void>;
  listDeadLetters(): Promise<Delivery[]>;
  takeDeadLetter(deliveryId: string): Promise<Delivery | undefined>;

  addRun(run: PipelineRun): Promise<void>;
  listRuns(limit: number): Promise<PipelineRun[]>;

  listLabs(): Promise<PartnerLab[]>;
  getLab(id: string): Promise<PartnerLab | undefined>;
  saveLab(lab: PartnerLab): Promise<void>;

  saveToken(token: IssuedToken): Promise<void>;
  getToken(tokenHash: string): Promise<IssuedToken | undefined>;
  deleteTokensForLab(labId: string): Promise<void>;

  listCatalogTests(): Promise<CatalogTest[]>;
  saveCatalogTest(test: CatalogTest): Promise<void>;
  listCatalogPackages(): Promise<CatalogPackage[]>;
  saveCatalogPackage(pkg: CatalogPackage): Promise<void>;

  listFlabsMappings(connectionId: string): Promise<FlabsMapping[]>;
  replaceFlabsMappings(connectionId: string, mappings: FlabsMapping[]): Promise<void>;

  appendIntegrationLog(entry: IntegrationLog): Promise<void>;
  listIntegrationLogs(limit: number): Promise<IntegrationLog[]>;

  listStaff(): Promise<StaffMember[]>;
  saveStaff(staff: StaffMember): Promise<void>;
  deleteStaff(id: string): Promise<void>;
  listAppointments(): Promise<Appointment[]>;
  saveAppointment(appointment: Appointment): Promise<void>;

  listIntegrations(): Promise<StudioIntegration[]>;
  saveIntegration(integration: StudioIntegration): Promise<void>;
  deleteIntegration(id: string): Promise<void>;

  getPrebookingSettings(connectionId: string): Promise<FlabsPrebookingSettings | null>;
  savePrebookingSettings(settings: FlabsPrebookingSettings): Promise<void>;

  /**
   * Generic documents for the Lab Portal (users, sessions, cases, reports). Every document has an `id`.
   * `where` matches fields by equality.
   */
  docList<T extends { id: string }>(collection: string, where?: Record<string, unknown>): Promise<T[]>;
  docGet<T extends { id: string }>(collection: string, id: string): Promise<T | undefined>;
  docPut<T extends { id: string }>(collection: string, doc: T): Promise<void>;
  docDelete(collection: string, id: string): Promise<void>;
  docDeleteWhere(collection: string, where: Record<string, unknown>): Promise<void>;

  listFlabsConnections(): Promise<StoredFlabsConnection[]>;
  saveFlabsConnection(connection: StoredFlabsConnection): Promise<void>;
  deleteFlabsConnection(id: string): Promise<void>;

  close(): Promise<void>;
}

// --- seed data -------------------------------------------------------------
// Written once, when a fresh database has no patients or labs. Existing data is
// never overwritten, so a restart keeps whatever the pipeline produced.

const day = 86_400_000;

export const seedPatients = (): MasterPatient[] => {
  const now = new Date().toISOString();
  return [
    {
      healjourId: "HJP-000001", mrns: ["MRN-88421", "NOIDA-5521"], nationalId: "91-2244-7781",
      phones: ["9810012345"], familyName: "Sharma", givenName: "Anil", birthDate: "1979-04-12", gender: "male",
      consents: [
        { purpose: "treatment", granted: true, grantedAt: "2026-01-04T09:00:00.000Z" },
        { purpose: "underwriting", granted: true, grantedAt: "2026-02-11T09:00:00.000Z", expiresAt: "2027-02-11T09:00:00.000Z" },
        { purpose: "claims", granted: true, grantedAt: "2026-02-11T09:00:00.000Z" },
        { purpose: "wellness", granted: false, grantedAt: "2026-02-11T09:00:00.000Z" },
        { purpose: "research", granted: false, grantedAt: "2026-02-11T09:00:00.000Z" }
      ],
      createdAt: now, lastSeenAt: now
    },
    {
      healjourId: "HJP-000002", mrns: ["MRN-90733"], phones: ["9999001122"],
      familyName: "Iyer", givenName: "Meera", birthDate: "1991-11-30", gender: "female",
      consents: [
        { purpose: "treatment", granted: true, grantedAt: "2026-03-02T09:00:00.000Z" },
        { purpose: "marketplace", granted: true, grantedAt: "2026-03-02T09:00:00.000Z" },
        { purpose: "wellness", granted: true, grantedAt: "2026-03-02T09:00:00.000Z" },
        { purpose: "underwriting", granted: false, grantedAt: "2026-03-02T09:00:00.000Z" }
      ],
      createdAt: now, lastSeenAt: now
    },
    {
      healjourId: "HJP-000003", mrns: ["MRN-11002"], phones: ["9820099887"],
      familyName: "Sharma", givenName: "Anita", birthDate: "1979-04-12", gender: "female",
      consents: [{ purpose: "treatment", granted: true, grantedAt: "2026-01-20T09:00:00.000Z" }],
      createdAt: now, lastSeenAt: now
    }
  ];
};

export const seedLabs = (): PartnerLab[] => [
  { id: "lab-noida", name: "Noida Diagnostic Centre", labCode: "LAB-NOIDA-01", status: "pending", requestedAt: new Date().toISOString(), credentialStatus: "not_created", scopes: [], version: 0 },
  { id: "lab-gurgaon", name: "Gurgaon Reference Lab", labCode: "LAB-GGN-02", status: "approved", requestedAt: new Date(Date.now() - day).toISOString(), reviewedAt: new Date().toISOString(), credentialStatus: "not_created", scopes: [], version: 0 },
  {
    id: "lab-faridabad", name: "Faridabad Pathology Centre", labCode: "LAB-FBD-03", status: "approved",
    requestedAt: new Date(Date.now() - 2 * day).toISOString(), reviewedAt: new Date().toISOString(),
    credentialStatus: "active", clientId: "hj_lab_fbd_demo7c",
    secretHash: `healjour-demo-salt:${scryptSync("demo-secret-never-use-in-production", "healjour-demo-salt", 32).toString("hex")}`,
    scopes: ["orders:read", "results:write"], createdAt: new Date(Date.now() - day).toISOString(), version: 1
  }
];

// Healjour's starter catalog. Codes match the local codes the normalizer already recognises.
// Prices are placeholders (0) until the lab sets real rates in the Test Catalog screen.
export const seedCatalogTests = (): CatalogTest[] => {
  const now = new Date().toISOString();
  const row = (code: string, name: string, loinc: string): CatalogTest => ({ code, name, loinc, price: 0, active: true, updatedAt: now });
  return [
    row("CBC", "CBC panel - Blood by Automated count", "58410-2"),
    row("GLU", "Fasting glucose", "1558-6"),
    row("HBA1C", "HbA1c", "4548-4"),
    row("TSH", "Thyroid stimulating hormone", "3016-3"),
    row("LIPID", "Lipid panel", "57698-3"),
    row("CREA", "Creatinine", "2160-0"),
    row("VITD", "Vitamin D 25-Hydroxy", "1989-3"),
    row("HGB", "Hemoglobin", "718-7"),
    row("WBC", "Leukocytes (WBC)", "6690-2"),
    row("PLT", "Platelets", "777-3"),
    row("CHOL", "Total cholesterol", "2093-3")
  ];
};

export const seedCatalogPackages = (): CatalogPackage[] => {
  const now = new Date().toISOString();
  return [
    { code: "BASIC-CHECK", name: "Basic health checkup", testCodes: ["CBC", "GLU", "CREA", "CHOL"], price: 0, active: true, updatedAt: now },
    { code: "THYROID", name: "Thyroid profile", testCodes: ["TSH"], price: 0, active: true, updatedAt: now }
  ];
};

// --- in-memory fallback ----------------------------------------------------

// "a.b" reads nested fields, like MongoDB's dotted paths.
const fieldAt = (doc: Record<string, unknown>, path: string): unknown =>
  path.split(".").reduce<unknown>((v, key) => (v && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined), doc);
const matches = (doc: Record<string, unknown>, where?: Record<string, unknown>) =>
  !where || Object.entries(where).every(([k, v]) => fieldAt(doc, k) === v);

class MemoryStore implements Store {
  readonly kind = "memory" as const;
  constructor(readonly detail: string) {}

  private docs = new Map<string, Map<string, unknown>>();
  private bucket(name: string) {
    let b = this.docs.get(name);
    if (!b) { b = new Map(); this.docs.set(name, b); }
    return b;
  }
  async docList<T extends { id: string }>(collection: string, where?: Record<string, unknown>) {
    return [...this.bucket(collection).values()].filter(d => matches(d as Record<string, unknown>, where)).map(d => structuredClone(d) as T);
  }
  async docGet<T extends { id: string }>(collection: string, id: string) {
    const d = this.bucket(collection).get(id);
    return d ? (structuredClone(d) as T) : undefined;
  }
  async docPut<T extends { id: string }>(collection: string, doc: T) { this.bucket(collection).set(doc.id, structuredClone(doc)); }
  async docDelete(collection: string, id: string) { this.bucket(collection).delete(id); }
  async docDeleteWhere(collection: string, where: Record<string, unknown>) {
    const b = this.bucket(collection);
    for (const [id, d] of b) if (matches(d as Record<string, unknown>, where)) b.delete(id);
  }

  private patients = new Map<string, MasterPatient>(seedPatients().map(p => [p.healjourId, p]));
  private audit: AuditEvent[] = [];
  private deadLetters: Delivery[] = [];
  private runs: PipelineRun[] = [];
  private labs = new Map<string, PartnerLab>(seedLabs().map(l => [l.id, l]));
  private tokens = new Map<string, IssuedToken>();
  private catalogTests = new Map<string, CatalogTest>(seedCatalogTests().map(t => [t.code, t]));
  private catalogPackages = new Map<string, CatalogPackage>(seedCatalogPackages().map(p => [p.code, p]));
  private flabsMappings = new Map<string, FlabsMapping>(); // key: connectionId:healjourCode
  private flabsConnections = new Map<string, StoredFlabsConnection>();
  private integrationLogs: IntegrationLog[] = [];

  async listPatients() { return [...this.patients.values()]; }
  async getPatient(id: string) { return this.patients.get(id); }
  async savePatient(patient: MasterPatient) { this.patients.set(patient.healjourId, patient); }
  async countPatients() { return this.patients.size; }

  async appendAudit(event: AuditEvent) { this.audit.push(event); }
  async lastAudit() { return this.audit.at(-1); }
  async listAudit(limit: number) { return this.audit.slice(-limit).reverse(); }
  async allAudit() { return [...this.audit]; }
  async countAudit() { return this.audit.length; }

  async addDeadLetter(delivery: Delivery) { this.deadLetters.push(delivery); }
  async listDeadLetters() { return [...this.deadLetters].reverse(); }
  async takeDeadLetter(deliveryId: string) {
    const index = this.deadLetters.findIndex(d => d.deliveryId === deliveryId);
    return index === -1 ? undefined : this.deadLetters.splice(index, 1)[0];
  }

  async addRun(run: PipelineRun) { this.runs.push(run); }
  async listRuns(limit: number) { return this.runs.slice(-limit).reverse(); }

  async listLabs() { return [...this.labs.values()]; }
  async getLab(id: string) { return this.labs.get(id); }
  async saveLab(lab: PartnerLab) { this.labs.set(lab.id, lab); }

  async saveToken(token: IssuedToken) { this.tokens.set(token.tokenHash, token); }
  async getToken(tokenHash: string) {
    const token = this.tokens.get(tokenHash);
    if (token && token.expiresAt.getTime() <= Date.now()) { this.tokens.delete(tokenHash); return undefined; }
    return token;
  }
  async deleteTokensForLab(labId: string) {
    for (const [hash, token] of this.tokens) if (token.labId === labId) this.tokens.delete(hash);
  }

  async listCatalogTests() { return [...this.catalogTests.values()]; }
  async saveCatalogTest(test: CatalogTest) { this.catalogTests.set(test.code, test); }
  async listCatalogPackages() { return [...this.catalogPackages.values()]; }
  async saveCatalogPackage(pkg: CatalogPackage) { this.catalogPackages.set(pkg.code, pkg); }

  async listFlabsMappings(connectionId: string) {
    return [...this.flabsMappings.values()].filter(m => m.connectionId === connectionId);
  }
  async replaceFlabsMappings(connectionId: string, mappings: FlabsMapping[]) {
    for (const key of [...this.flabsMappings.keys()]) if (key.startsWith(`${connectionId}:`)) this.flabsMappings.delete(key);
    for (const m of mappings) this.flabsMappings.set(`${connectionId}:${m.kind}:${m.healjourCode}`, m);
  }

  async appendIntegrationLog(entry: IntegrationLog) { this.integrationLogs.push(entry); if (this.integrationLogs.length > 2000) this.integrationLogs.shift(); }
  async listIntegrationLogs(limit: number) { return this.integrationLogs.slice(-limit).reverse(); }

  private staffList = new Map<string, StaffMember>();
  private appointmentList = new Map<string, Appointment>();

  async listStaff() { return [...this.staffList.values()]; }
  async saveStaff(staff: StaffMember) { this.staffList.set(staff.id, staff); }
  async deleteStaff(id: string) { this.staffList.delete(id); }
  async listAppointments() { return [...this.appointmentList.values()]; }
  async saveAppointment(appointment: Appointment) { this.appointmentList.set(appointment.id, appointment); }

  private integrationList = new Map<string, StudioIntegration>();
  async listIntegrations() { return [...this.integrationList.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  async saveIntegration(integration: StudioIntegration) { this.integrationList.set(integration.id, integration); }
  async deleteIntegration(id: string) { this.integrationList.delete(id); }

  private prebookingSettings = new Map<string, FlabsPrebookingSettings>();
  async getPrebookingSettings(connectionId: string) { return this.prebookingSettings.get(connectionId) ?? null; }
  async savePrebookingSettings(settings: FlabsPrebookingSettings) { this.prebookingSettings.set(settings.connectionId, settings); }

  async listFlabsConnections() { return [...this.flabsConnections.values()]; }
  async saveFlabsConnection(connection: StoredFlabsConnection) { this.flabsConnections.set(connection.id, connection); }
  async deleteFlabsConnection(id: string) { this.flabsConnections.delete(id); }

  async close() { /* nothing to release */ }
}

// --- MongoDB ---------------------------------------------------------------

type WithId<T> = T & { _id: string };
const withId = <T extends object>(id: string, doc: T): WithId<T> => ({ ...doc, _id: id });
const strip = <T>(doc: (T & { _id?: unknown }) | null): T | undefined => {
  if (!doc) return undefined;
  const { _id, ...rest } = doc;
  return rest as T;
};

class MongoStore implements Store {
  readonly kind = "mongodb" as const;

  private patients: Collection<WithId<MasterPatient>>;
  private audit: Collection<WithId<AuditEvent>>;
  private deadLetters: Collection<WithId<Delivery>>;
  private runs: Collection<WithId<PipelineRun>>;
  private labs: Collection<WithId<PartnerLab>>;
  private tokens: Collection<WithId<IssuedToken>>;
  private catalogTests: Collection<WithId<CatalogTest>>;
  private catalogPackages: Collection<WithId<CatalogPackage>>;
  private flabsMappings: Collection<WithId<FlabsMapping>>;
  private flabsConnections: Collection<WithId<StoredFlabsConnection>>;
  private integrationLogs: Collection<WithId<IntegrationLog>>;

  constructor(private client: MongoClient, private db: Db, readonly detail: string) {
    this.flabsMappings = db.collection("flabsMappings");
    this.flabsConnections = db.collection("flabsConnections");
    this.integrationLogs = db.collection("integrationLogs");
    this.staffCollection = db.collection("staff");
    this.appointmentCollection = db.collection("appointments");
    this.integrationCollection = db.collection("integrations");
    this.prebookingCollection = db.collection("flabsPrebookingSettings");
    this.patients = db.collection("patients");
    this.audit = db.collection("audit");
    this.deadLetters = db.collection("deadLetters");
    this.runs = db.collection("runs");
    this.labs = db.collection("partnerLabs");
    this.tokens = db.collection("accessTokens");
    this.catalogTests = db.collection("catalogTests");
    this.catalogPackages = db.collection("catalogPackages");
  }

  /** Indexes the queries below rely on, plus TTL cleanup for expired tokens. */
  async init() {
    await Promise.all([
      this.patients.createIndex({ mrns: 1 }),
      this.patients.createIndex({ phones: 1 }),
      this.patients.createIndex({ nationalId: 1 }, { sparse: true }),
      this.audit.createIndex({ seq: -1 }),
      this.deadLetters.createIndex({ deliveryId: 1 }, { unique: true }),
      this.runs.createIndex({ startedAt: -1 }),
      this.labs.createIndex({ clientId: 1 }, { sparse: true }),
      this.tokens.createIndex({ labId: 1 }),
      this.tokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
    ]);
    if (await this.patients.countDocuments({}, { limit: 1 }) === 0) {
      await this.patients.insertMany(seedPatients().map(p => withId(p.healjourId, p)));
    }
    if (await this.labs.countDocuments({}, { limit: 1 }) === 0) {
      await this.labs.insertMany(seedLabs().map(l => withId(l.id, l)));
    }
    if (await this.catalogTests.countDocuments({}, { limit: 1 }) === 0) {
      await this.catalogTests.insertMany(seedCatalogTests().map(t => withId(t.code, t)));
    }
    if (await this.catalogPackages.countDocuments({}, { limit: 1 }) === 0) {
      await this.catalogPackages.insertMany(seedCatalogPackages().map(p => withId(p.code, p)));
    }
    return this;
  }

  async listPatients() {
    return (await this.patients.find().sort({ healjourId: 1 }).toArray()).map(d => strip<MasterPatient>(d)!);
  }
  async getPatient(id: string) { return strip<MasterPatient>(await this.patients.findOne({ _id: id })); }
  async savePatient(patient: MasterPatient) {
    await this.patients.replaceOne({ _id: patient.healjourId }, withId(patient.healjourId, patient), { upsert: true });
  }
  async countPatients() { return this.patients.countDocuments(); }

  async appendAudit(event: AuditEvent) {
    await this.audit.insertOne(withId(`audit-${event.seq}`, event));
  }
  async lastAudit() { return strip<AuditEvent>(await this.audit.findOne({}, { sort: { seq: -1 } })); }
  async listAudit(limit: number) {
    return (await this.audit.find().sort({ seq: -1 }).limit(limit).toArray()).map(d => strip<AuditEvent>(d)!);
  }
  async allAudit() {
    return (await this.audit.find().sort({ seq: 1 }).toArray()).map(d => strip<AuditEvent>(d)!);
  }
  async countAudit() { return this.audit.countDocuments(); }

  async addDeadLetter(delivery: Delivery) {
    await this.deadLetters.replaceOne({ _id: delivery.deliveryId }, withId(delivery.deliveryId, delivery), { upsert: true });
  }
  async listDeadLetters() {
    return (await this.deadLetters.find().toArray()).map(d => strip<Delivery>(d)!).reverse();
  }
  async takeDeadLetter(deliveryId: string) {
    // findOneAndDelete keeps the replay atomic: two clicks cannot replay the same delivery twice.
    const doc = await this.deadLetters.findOneAndDelete({ _id: deliveryId });
    return strip<Delivery>(doc as WithId<Delivery> | null);
  }

  async addRun(run: PipelineRun) {
    await this.runs.replaceOne({ _id: run.runId }, withId(run.runId, run), { upsert: true });
  }
  async listRuns(limit: number) {
    return (await this.runs.find().sort({ startedAt: -1 }).limit(limit).toArray()).map(d => strip<PipelineRun>(d)!);
  }

  async listLabs() {
    return (await this.labs.find().sort({ requestedAt: 1 }).toArray()).map(d => strip<PartnerLab>(d)!);
  }
  async getLab(id: string) { return strip<PartnerLab>(await this.labs.findOne({ _id: id })); }
  async saveLab(lab: PartnerLab) {
    await this.labs.replaceOne({ _id: lab.id }, withId(lab.id, lab), { upsert: true });
  }

  async saveToken(token: IssuedToken) {
    await this.tokens.replaceOne({ _id: token.tokenHash }, withId(token.tokenHash, token), { upsert: true });
  }
  async getToken(tokenHash: string) {
    // The TTL monitor only sweeps once a minute, so expiry is still checked on read.
    const token = strip<IssuedToken>(await this.tokens.findOne({ _id: tokenHash }));
    if (token && new Date(token.expiresAt).getTime() <= Date.now()) return undefined;
    return token;
  }
  async deleteTokensForLab(labId: string) { await this.tokens.deleteMany({ labId }); }

  async listCatalogTests() {
    return (await this.catalogTests.find().sort({ code: 1 }).toArray()).map(d => strip<CatalogTest>(d)!);
  }
  async saveCatalogTest(test: CatalogTest) {
    await this.catalogTests.replaceOne({ _id: test.code }, withId(test.code, test), { upsert: true });
  }
  async listCatalogPackages() {
    return (await this.catalogPackages.find().sort({ code: 1 }).toArray()).map(d => strip<CatalogPackage>(d)!);
  }
  async saveCatalogPackage(pkg: CatalogPackage) {
    await this.catalogPackages.replaceOne({ _id: pkg.code }, withId(pkg.code, pkg), { upsert: true });
  }

  async listFlabsMappings(connectionId: string) {
    return (await this.flabsMappings.find({ connectionId }).toArray()).map(d => strip<FlabsMapping>(d)!);
  }
  async replaceFlabsMappings(connectionId: string, mappings: FlabsMapping[]) {
    await this.flabsMappings.deleteMany({ connectionId });
    if (mappings.length) await this.flabsMappings.insertMany(mappings.map(m => withId(`${connectionId}:${m.kind}:${m.healjourCode}`, m)));
  }

  async appendIntegrationLog(entry: IntegrationLog) {
    await this.integrationLogs.insertOne(withId(entry.id, entry));
  }
  async listIntegrationLogs(limit: number) {
    return (await this.integrationLogs.find().sort({ at: -1 }).limit(limit).toArray()).map(d => strip<IntegrationLog>(d)!);
  }

  private staffCollection!: Collection<WithId<StaffMember>>;
  private appointmentCollection!: Collection<WithId<Appointment>>;
  private integrationCollection!: Collection<WithId<StudioIntegration>>;

  async listIntegrations() {
    return (await this.integrationCollection.find().sort({ updatedAt: -1 }).toArray()).map(d => strip<StudioIntegration>(d)!);
  }
  async saveIntegration(integration: StudioIntegration) {
    await this.integrationCollection.replaceOne({ _id: integration.id }, withId(integration.id, integration), { upsert: true });
  }
  async deleteIntegration(id: string) { await this.integrationCollection.deleteOne({ _id: id }); }

  private prebookingCollection!: Collection<WithId<FlabsPrebookingSettings>>;
  async getPrebookingSettings(connectionId: string) {
    return strip<FlabsPrebookingSettings>(await this.prebookingCollection.findOne({ _id: connectionId })) ?? null;
  }
  async savePrebookingSettings(settings: FlabsPrebookingSettings) {
    await this.prebookingCollection.replaceOne({ _id: settings.connectionId }, withId(settings.connectionId, settings), { upsert: true });
  }

  async listStaff() {
    return (await this.staffCollection.find().sort({ name: 1 }).toArray()).map(d => strip<StaffMember>(d)!);
  }
  async saveStaff(staff: StaffMember) {
    await this.staffCollection.replaceOne({ _id: staff.id }, withId(staff.id, staff), { upsert: true });
  }
  async deleteStaff(id: string) { await this.staffCollection.deleteOne({ _id: id }); }
  async listAppointments() {
    return (await this.appointmentCollection.find().sort({ scheduledAt: 1 }).toArray()).map(d => strip<Appointment>(d)!);
  }
  async saveAppointment(appointment: Appointment) {
    await this.appointmentCollection.replaceOne({ _id: appointment.id }, withId(appointment.id, appointment), { upsert: true });
  }

  async listFlabsConnections() {
    return (await this.flabsConnections.find().sort({ updatedAt: 1 }).toArray()).map(d => strip<StoredFlabsConnection>(d)!);
  }
  async saveFlabsConnection(connection: StoredFlabsConnection) {
    await this.flabsConnections.replaceOne({ _id: connection.id }, withId(connection.id, connection), { upsert: true });
  }
  async deleteFlabsConnection(id: string) {
    await this.flabsConnections.deleteOne({ _id: id });
    await this.flabsMappings.deleteMany({ connectionId: id });
  }

  async docList<T extends { id: string }>(collection: string, where?: Record<string, unknown>) {
    return (await this.db.collection(collection).find(where ?? {}).toArray()).map(d => strip<T>(d as never)!);
  }
  async docGet<T extends { id: string }>(collection: string, id: string) {
    const d = await this.db.collection<{ _id: string }>(collection).findOne({ _id: id });
    return d ? strip<T>(d as never) : undefined;
  }
  async docPut<T extends { id: string }>(collection: string, doc: T) {
    await this.db.collection<{ _id: string }>(collection).replaceOne({ _id: doc.id }, withId(doc.id, doc) as never, { upsert: true });
  }
  async docDelete(collection: string, id: string) { await this.db.collection<{ _id: string }>(collection).deleteOne({ _id: id }); }
  async docDeleteWhere(collection: string, where: Record<string, unknown>) { await this.db.collection(collection).deleteMany(where); }

  async close() { await this.client.close(); }
}

// --- connection ------------------------------------------------------------

let store: Store | undefined;

/** Hides credentials when the URI is printed or returned by /api/health. */
export function describeUri(uri: string) {
  try {
    const parsed = new URL(uri);
    const auth = parsed.username ? `${parsed.username}:***@` : "";
    return `${parsed.protocol}//${auth}${parsed.host}`;
  } catch {
    return "mongodb (unparsable URI)";
  }
}

const reconnectListeners: Array<() => Promise<void> | void> = [];
/** Runs after a degraded (in-memory) server reaches MongoDB again, e.g. to reload cached Flabs accounts. */
export const onStoreReconnected = (fn: () => Promise<void> | void) => { reconnectListeners.push(fn); };
let reconnectTimer: ReturnType<typeof setInterval> | undefined;

/**
 * True when MONGODB_URI is configured but the server is running on the in-memory fallback.
 * Sign-in must not offer first-run setup then: an admin created now would vanish once MongoDB is back.
 */
export const storageDegraded = () => Boolean(process.env.MONGODB_URI?.trim()) && store?.kind === "memory";

// Node on Windows sometimes fails the SRV lookup that mongodb+srv:// needs (querySrv ECONNREFUSED / ETIMEOUT)
// while the network is fine. Retrying with public resolvers fixes it; only Node's own resolver is changed.
const isDnsError = (e: unknown) => e instanceof Error && /querySrv|queryTxt|ENOTFOUND|EAI_AGAIN|ECONNREFUSED.*_mongodb|ETIMEOUT/i.test(e.message);

async function openMongo(uri: string, dbName: string, target: string): Promise<MongoStore> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: Number(process.env.MONGODB_TIMEOUT_MS || 5000) });
    try {
      await client.connect();
      await client.db(dbName).command({ ping: 1 });
      return await new MongoStore(client, client.db(dbName), target).init();
    } catch (error) {
      lastError = error;
      await client.close().catch(() => undefined);
      if (!isDnsError(error)) break;
      dns.setServers(["8.8.8.8", "1.1.1.1", ...dns.getServers().filter(s => s !== "8.8.8.8" && s !== "1.1.1.1")]);
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
  throw lastError;
}

export async function connectStore(): Promise<Store> {
  if (store) return store;
  const uri = process.env.MONGODB_URI?.trim() || "mongodb://127.0.0.1:27017";
  const dbName = process.env.MONGODB_DB?.trim() || "healjour_integration_studio";
  const target = `${describeUri(uri)}/${dbName}`;

  try {
    store = await openMongo(uri, dbName, target);
    console.log(`Storage: MongoDB at ${target}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : "unknown error";
    store = new MemoryStore(`MongoDB at ${target} unreachable: ${reason}`);
    console.warn(`Storage: in-memory fallback. ${store.detail}`);
    if (process.env.MONGODB_URI?.trim() && !reconnectTimer) {
      // Keep trying in the background and switch over as soon as MongoDB answers, without a restart.
      console.warn("Storage: retrying MongoDB every 15 s; the in-memory data is temporary.");
      reconnectTimer = setInterval(async () => {
        try {
          const mongo = await openMongo(uri, dbName, target);
          clearInterval(reconnectTimer); reconnectTimer = undefined;
          store = mongo;
          console.log(`Storage: reconnected to MongoDB at ${target}`);
          for (const fn of reconnectListeners) await Promise.resolve(fn()).catch(e => console.warn("Storage: reconnect hook failed:", e));
        } catch { /* still unreachable; try again next tick */ }
      }, 15_000);
      reconnectTimer.unref?.();
    } else if (!process.env.MONGODB_URI?.trim()) {
      console.warn("Set MONGODB_URI to a reachable server for durable storage. Data will reset on restart.");
    }
  }
  return store;
}

/** Every caller after startup uses this; connectStore() runs once in the entry point. */
export function getStore(): Store {
  if (!store) throw new Error("Store has not been initialised. Call connectStore() during startup.");
  return store;
}
