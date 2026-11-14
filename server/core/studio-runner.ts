// Runs a saved Integration Studio connection end to end against a local sandbox that stands in for SFTP:
//   send     Healjour orders -> CSV file in the outbound folder (outbound mapping + the integration's delimiter)
//   lab      a simulated lab picks the orders file up and drops a results CSV in the inbound folder
//   receive  inbound results -> inbound mapping -> safety rules -> Healjour Core pipeline -> processed/ or rejected/
// No real SFTP host or lab is contacted. Synthetic data only.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { StudioIntegration } from "./models.js";
import { runPipeline } from "./pipeline.js";
import { getStore } from "./store.js";

// Vercel's filesystem is read-only except the temp folder.
const SANDBOX_ROOT = process.env.VERCEL ? join(tmpdir(), "healjour-sandbox") : resolve(process.cwd(), ".sandbox");

/** Healjour field -> lab column, as shown in the wizard's "Match the columns" step (outbound tab). */
export const OUTBOUND_MAPPING: Array<[string, string]> = [
  ["order_id", "LabOrderRef"],
  ["patient_ref", "PatientCode"],
  ["first_name", "PatientFirstName"],
  ["last_name", "PatientLastName"],
  ["dob", "PatientDOB"],
  ["sex", "PatientSex"],
  ["mobile", "PatientMobile"],
  ["test_code", "InvestigationCode"],
  ["priority", "Priority"],
  ["ordered_at", "OrderDate"]
];

/** Lab column -> Healjour field, as shown in the wizard's inbound tab. Unknown lab columns are kept as they are. */
export const INBOUND_MAPPING: Record<string, string> = {
  LabOrderRef: "order_id",
  AccessionNo: "accession_number",
  PatientCode: "patient_ref",
  PatientFirstName: "first_name",
  PatientLastName: "last_name",
  PatientDOB: "dob",
  PatientSex: "sex",
  PatientMobile: "mobile",
  InvestigationCode: "test_code",
  LabStatus: "sample_status",
  ResultValue: "result_value",
  Units: "unit",
  RefRange: "reference_range",
  Flag: "abnormal_flag",
  Approved: "approval_status",
  ResultDate: "resulted_at"
};

/** Columns a results file must have when "Required headers present" is on. */
const REQUIRED_INBOUND_HEADERS = ["LabOrderRef", "PatientCode", "InvestigationCode", "ResultValue", "Approved"];

// Invented demo patients for the sandbox. Not real people.
const DEMO_PATIENTS = [
  { ref: "NOI-0001", first: "Kiran", last: "Mehta", dob: "14/02/1985", sex: "F", mobile: "9000000101" },
  { ref: "NOI-0002", first: "Rohit", last: "Bansal", dob: "03/11/1979", sex: "M", mobile: "9000000102" },
  { ref: "NOI-0003", first: "Pooja", last: "Arora", dob: "22/07/1992", sex: "F", mobile: "9000000103" },
  { ref: "NOI-0004", first: "Sameer", last: "Kapoor", dob: "09/05/1968", sex: "M", mobile: "9000000104" },
  { ref: "NOI-0005", first: "Nisha", last: "Malhotra", dob: "30/12/1990", sex: "F", mobile: "9000000105" }
];

// What the simulated lab reports for each test: unit and normal range.
const LAB_RESULTS: Record<string, { unit: string; low: number; high: number; decimals: number }> = {
  CBC: { unit: "10^3/uL", low: 4, high: 11, decimals: 1 },
  WBC: { unit: "10^3/uL", low: 4, high: 11, decimals: 1 },
  PLT: { unit: "10^3/uL", low: 150, high: 450, decimals: 0 },
  GLU: { unit: "mg/dL", low: 70, high: 100, decimals: 0 },
  HBA1C: { unit: "%", low: 4, high: 5.6, decimals: 1 },
  TSH: { unit: "uIU/mL", low: 0.4, high: 4, decimals: 2 },
  LIPID: { unit: "mg/dL", low: 0, high: 200, decimals: 0 },
  CHOL: { unit: "mg/dL", low: 0, high: 200, decimals: 0 },
  CREA: { unit: "mg/dL", low: 0.6, high: 1.3, decimals: 2 },
  VITD: { unit: "ng/mL", low: 30, high: 100, decimals: 1 },
  HGB: { unit: "g/dL", low: 12, high: 17, decimals: 1 }
};

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const ddmmyyyy = (d = new Date()) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
const batchId = () => randomBytes(3).toString("hex").toUpperCase();

function folders(integration: StudioIntegration) {
  const base = join(SANDBOX_ROOT, integration.labCode);
  const outbound = integration.outboundPath ? join(base, integration.outboundPath) : null;
  const inbound = integration.inboundPath ? join(base, integration.inboundPath) : null;
  return {
    base,
    outbound,
    pickedUp: outbound ? join(outbound, "picked-up") : null,
    inbound,
    processed: inbound ? join(inbound, "processed") : null,
    rejected: inbound ? join(inbound, "rejected") : null
  };
}

const ensure = (dir: string | null) => { if (dir) mkdirSync(dir, { recursive: true }); };
const csvFiles = (dir: string | null) =>
  dir && existsSync(dir) ? readdirSync(dir).filter(f => f.toLowerCase().endsWith(".csv") && statSync(join(dir, f)).isFile()).sort() : [];

function toCsv(rows: string[][], delimiter: string) {
  const cell = (v: string) => (v.includes(delimiter) || v.includes('"') || /[\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map(r => r.map(cell).join(delimiter)).join("\n") + "\n";
}

function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}

export type SendResult = { file: string; orders: number; rows: Array<Record<string, string>> };

/** Writes a batch of Healjour orders to the outbound folder, using the outbound mapping and delimiter. */
export async function sendOrders(integration: StudioIntegration, count: number): Promise<SendResult> {
  const dirs = folders(integration);
  if (!dirs.outbound) throw new Error("This integration only receives results, so it has no outbound folder.");
  ensure(dirs.outbound);

  const known = new Set(Object.keys(LAB_RESULTS));
  const tests = (await getStore().listCatalogTests()).filter(t => t.active && known.has(t.code)).map(t => t.code);
  if (!tests.length) throw new Error("No active catalog tests to order.");

  const batch = batchId();
  const orderedAt = ddmmyyyy();
  const records = Array.from({ length: count }, (_, i) => {
    const p = DEMO_PATIENTS[i % DEMO_PATIENTS.length];
    return {
      order_id: `HJ-${batch}-${String(i + 1).padStart(3, "0")}`,
      patient_ref: p.ref, first_name: p.first, last_name: p.last, dob: p.dob, sex: p.sex, mobile: p.mobile,
      test_code: tests[(i * 3) % tests.length],
      priority: i === 0 ? "Urgent" : "Routine",
      ordered_at: orderedAt
    } as Record<string, string>;
  });
  const header = OUTBOUND_MAPPING.map(([, lab]) => lab);
  const rows = records.map(r => OUTBOUND_MAPPING.map(([field]) => r[field] ?? ""));
  const file = `orders_${stamp()}_${batch}.csv`;
  writeFileSync(join(dirs.outbound, file), toCsv([header, ...rows], integration.delimiter), "utf8");
  return { file, orders: records.length, rows: records };
}

export type LabResult = { pickedUp: string[]; resultsFile: string | null; results: number };

/** The simulated lab: picks up every orders file and answers with one results file. */
export function simulateLab(integration: StudioIntegration): LabResult {
  const dirs = folders(integration);
  if (!dirs.outbound || !dirs.inbound) {
    throw new Error("The lab simulator needs both folders: set the integration to send and receive.");
  }
  ensure(dirs.pickedUp); ensure(dirs.inbound);
  const files = csvFiles(dirs.outbound);
  if (!files.length) return { pickedUp: [], resultsFile: null, results: 0 };

  const header = ["LabOrderRef", "AccessionNo", "PatientCode", "PatientFirstName", "PatientLastName", "PatientDOB", "PatientSex", "PatientMobile",
    "InvestigationCode", "LabStatus", "ResultValue", "Units", "RefRange", "Flag", "Approved", "ResultDate"];
  const rows: string[][] = [];
  for (const file of files) {
    const [head, ...body] = parseCsv(readFileSync(join(dirs.outbound, file), "utf8"), integration.delimiter);
    const col = (name: string) => head.indexOf(name);
    for (const r of body) {
      const code = r[col("InvestigationCode")] ?? "";
      const spec = LAB_RESULTS[code];
      if (!spec) continue;
      const span = spec.high - spec.low;
      const value = (spec.low - span * 0.15 + Math.random() * span * 1.3).toFixed(spec.decimals);
      const flag = Number(value) < spec.low ? "L" : Number(value) > spec.high ? "H" : "N";
      rows.push([
        r[col("LabOrderRef")], `ACC-${randomBytes(3).toString("hex").toUpperCase()}`,
        r[col("PatientCode")], r[col("PatientFirstName")], r[col("PatientLastName")], r[col("PatientDOB")], r[col("PatientSex")], r[col("PatientMobile")],
        code, "Completed", value, spec.unit, `${spec.low}-${spec.high}`, flag, "Approved", ddmmyyyy()
      ]);
    }
    renameSync(join(dirs.outbound, file), join(dirs.pickedUp!, file));
  }
  const resultsFile = `results_${stamp()}_${batchId()}.csv`;
  writeFileSync(join(dirs.inbound, resultsFile), toCsv([header, ...rows], integration.delimiter), "utf8");
  return { pickedUp: files, resultsFile, results: rows.length };
}

export type FileOutcome = {
  file: string;
  status: "imported" | "imported_with_issues" | "rejected" | "duplicate";
  rows: number;
  reason?: string;
  runId?: string;
  delivered?: number;
  quarantined?: number;
  issues?: string[];
};

/** Reads every results file in the inbound folder, applies the integration's rules, and runs the Core pipeline. */
export async function receiveResults(integration: StudioIntegration, seenChecksums: string[]): Promise<{ outcomes: FileOutcome[]; checksums: string[] }> {
  const dirs = folders(integration);
  if (!dirs.inbound) throw new Error("This integration only sends orders, so it has no inbound folder.");
  ensure(dirs.inbound); ensure(dirs.processed); ensure(dirs.rejected);
  const rules = integration.validationRules;
  const seen = new Set(seenChecksums);
  const outcomes: FileOutcome[] = [];

  for (const file of csvFiles(dirs.inbound)) {
    const path = join(dirs.inbound, file);
    const text = readFileSync(path, "utf8");
    const checksum = createHash("sha256").update(text).digest("hex");
    const move = (to: string) => renameSync(path, join(to, file));

    if (rules.detectDuplicates && seen.has(checksum)) {
      move(dirs.rejected!);
      outcomes.push({ file, status: "duplicate", rows: 0, reason: "Same file content was already imported (checksum match). Skipped and audited." });
      continue;
    }

    const [head = [], ...body] = parseCsv(text, integration.delimiter);
    const missing = REQUIRED_INBOUND_HEADERS.filter(h => !head.includes(h));
    if (rules.requiredHeaders && missing.length) {
      move(dirs.rejected!);
      outcomes.push({ file, status: "rejected", rows: body.length, reason: `Missing required columns: ${missing.join(", ")}.` });
      continue;
    }

    // Inbound mapping: rename lab columns to Healjour fields, then hand a standard CSV to the pipeline.
    const mappedHeader = head.map(h => INBOUND_MAPPING[h] ?? h);
    const payload = toCsv([mappedHeader, ...body], ",");
    const run = await runPipeline({
      connectorId: "path-csv-results",
      payload,
      delimiter: ",",
      sinks: ["healjour_record"],
      normalization: {
        rejectUnknownTestCodes: rules.rejectUnknownTestCodes,
        validateDates: rules.validateDates,
        requireApprovedResults: rules.requireApprovedResults
      },
      quarantineOnAmbiguity: rules.quarantinePatientMismatch
    });

    const deliveries = run.deliveries as Array<{ status: string }>;
    const decisions = run.identityDecisions as Array<{ quarantined?: boolean }>;
    const issues = run.layers.flatMap(l => l.issues).filter(i => i.severity !== "info").map(i => `${i.layer}: ${i.message}`);
    seen.add(checksum);
    if (run.status === "stopped") {
      move(dirs.rejected!);
      outcomes.push({ file, status: "rejected", rows: body.length, runId: run.runId, reason: `Stopped at ${run.stoppedAtLayer}.`, issues: issues.slice(0, 6) });
    } else {
      move(dirs.processed!);
      outcomes.push({
        file, status: run.status === "completed" ? "imported" : "imported_with_issues", rows: body.length, runId: run.runId,
        delivered: deliveries.filter(d => d.status === "delivered").length,
        quarantined: decisions.filter(d => d.quarantined).length,
        issues: issues.slice(0, 6)
      });
    }
  }
  return { outcomes, checksums: [...seen].slice(-200) };
}

export type FolderListing = Record<"outbound" | "pickedUp" | "inbound" | "processed" | "rejected", Array<{ name: string; rows: number; bytes: number }>>;

/** What is in each sandbox folder right now, for the screen. */
export function listFolders(integration: StudioIntegration): { root: string; folders: FolderListing; paths: Record<string, string | null> } {
  const dirs = folders(integration);
  const describe = (dir: string | null) => csvFiles(dir).map(name => {
    const text = readFileSync(join(dir!, name), "utf8");
    return { name, rows: Math.max(0, parseCsv(text, integration.delimiter).length - 1), bytes: Buffer.byteLength(text) };
  });
  const rel = (dir: string | null) => (dir ? dir.slice(SANDBOX_ROOT.length).replace(/\\/g, "/") : null);
  return {
    root: process.env.VERCEL ? "temporary sandbox" : ".sandbox",
    folders: {
      outbound: describe(dirs.outbound), pickedUp: describe(dirs.pickedUp),
      inbound: describe(dirs.inbound), processed: describe(dirs.processed), rejected: describe(dirs.rejected)
    },
    paths: { outbound: rel(dirs.outbound), pickedUp: rel(dirs.pickedUp), inbound: rel(dirs.inbound), processed: rel(dirs.processed), rejected: rel(dirs.rejected) }
  };
}
