// Flabs CRM as a Healjour sink. Two jobs:
//   1. syncFlabsCatalog(): match Healjour catalog tests to Flabs tests by code.
//   2. deliverToFlabs(record): turn a canonical order into a Flabs lead/booking and send it.

import type { CanonicalRecord } from "../types.js";
import type { CatalogTest, FlabsMapping } from "../models.js";
import { getStore } from "../store.js";
import { createLead, listPackages, listTests, FlabsError, type CreateLeadPayload, type FlabsConfig } from "./client.js";
import { autoPrebook, describeAutoPrebook } from "./auto.js";

export type SyncReport = {
  branchId: string;
  flabsTestCount: number;
  matched: Array<{ healjourCode: string; flabsCode: string; flabsCost: number }>;
  /** Healjour tests with no Flabs test of the same code. They will go out as unmappedTests. */
  healjourOnly: string[];
  /** Flabs tests with no Healjour test of the same code. Candidates to add to the catalog. */
  flabsOnly: string[];
  packages: {
    flabsPackageCount: number;
    matched: Array<{ healjourCode: string; flabsCode: string; flabsPrice: number }>;
    healjourOnly: string[];
    flabsOnly: string[];
  };
};

/** Matches the catalog against one Flabs account: tests and packages, by code, with that account's rates. */
export async function syncFlabsCatalog(config: FlabsConfig): Promise<SyncReport> {
  if (!config.branchId) throw new Error("Choose a Flabs branch for this account.");
  const store = getStore();
  const now = new Date().toISOString();

  const flabsTests = await listTests(config, config.branchId);
  const flabsTestByCode = new Map(flabsTests.map(t => [t.code.trim().toUpperCase(), t]));
  const healjourTests = await store.listCatalogTests();
  const existing = await store.listFlabsMappings(config.id);
  const testMappings: FlabsMapping[] = [];
  const healjourOnly: string[] = [];
  for (const test of healjourTests) {
    // Manual choices survive a sync; the Flabs name and rate are refreshed from the live list.
    const manual = existing.find(m => m.kind === "test" && m.source === "manual" && m.healjourCode === test.code);
    if (manual) {
      const live = flabsTests.find(t => t._id === manual.flabsId);
      testMappings.push({ ...manual, flabsCode: live?.code ?? manual.flabsCode, flabsName: live?.name ?? manual.flabsName, flabsCost: live?.cost ?? manual.flabsCost, syncedAt: now });
      continue;
    }
    const match = flabsTestByCode.get(test.code.toUpperCase());
    if (match) {
      testMappings.push({ connectionId: config.id, kind: "test", healjourCode: test.code, flabsId: match._id, flabsCode: match.code, flabsName: match.name, flabsCost: match.cost, source: "auto", syncedAt: now });
    } else {
      healjourOnly.push(test.code);
    }
  }
  const matchedTestCodes = new Set(testMappings.map(m => m.flabsCode.toUpperCase()));
  const flabsOnly = flabsTests.filter(t => !matchedTestCodes.has(t.code.toUpperCase())).map(t => t.code);

  const flabsPackages = await listPackages(config, config.branchId);
  const flabsPackageByCode = new Map(flabsPackages.map(p => [p.code.trim().toUpperCase(), p]));
  const healjourPackages = await store.listCatalogPackages();
  const packageMappings: FlabsMapping[] = [];
  const packageHealjourOnly: string[] = [];
  for (const pkg of healjourPackages) {
    // Manual choices survive a sync, like tests.
    const manual = existing.find(m => m.kind === "package" && m.source === "manual" && m.healjourCode === pkg.code);
    if (manual) {
      const live = flabsPackages.find(p => p._id === manual.flabsId);
      packageMappings.push({ ...manual, flabsCode: live?.code ?? manual.flabsCode, flabsName: live?.name ?? manual.flabsName, flabsCost: live?.total ?? manual.flabsCost, syncedAt: now });
      continue;
    }
    const match = flabsPackageByCode.get(pkg.code.toUpperCase());
    if (match) {
      packageMappings.push({ connectionId: config.id, kind: "package", healjourCode: pkg.code, flabsId: match._id, flabsCode: match.code, flabsName: match.name, flabsCost: match.total, syncedAt: now });
    } else {
      packageHealjourOnly.push(pkg.code);
    }
  }
  const matchedPackageCodes = new Set(packageMappings.map(m => m.flabsCode.toUpperCase()));
  const packageFlabsOnly = flabsPackages.filter(p => !matchedPackageCodes.has(p.code.toUpperCase())).map(p => p.code);

  await store.replaceFlabsMappings(config.id, [...testMappings, ...packageMappings]);
  return {
    branchId: config.branchId,
    flabsTestCount: flabsTests.length,
    matched: testMappings.map(m => ({ healjourCode: m.healjourCode, flabsCode: m.flabsCode, flabsCost: m.flabsCost })),
    healjourOnly,
    flabsOnly,
    packages: {
      flabsPackageCount: flabsPackages.length,
      matched: packageMappings.map(m => ({ healjourCode: m.healjourCode, flabsCode: m.flabsCode, flabsPrice: m.flabsCost })),
      healjourOnly: packageHealjourOnly,
      flabsOnly: packageFlabsOnly
    }
  };
}

/** Flabs is strict about patient fields; anything missing here stops the record instead of guessing. */
export function ageInYears(birthDate: string, today = new Date()): number | undefined {
  const dob = new Date(`${birthDate}T00:00:00Z`);
  if (Number.isNaN(dob.getTime())) return undefined;
  let years = today.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday = today.getUTCMonth() < dob.getUTCMonth() || (today.getUTCMonth() === dob.getUTCMonth() && today.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) years -= 1;
  return years >= 0 ? years : undefined;
}

/** Flabs wants exactly 10 digits without country code. */
export function tenDigitContact(phone?: string): string | undefined {
  const digits = (phone ?? "").replace(/\D/g, "");
  const local = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
  return local.length === 10 ? local : undefined;
}

const priorityToFlabs = { stat: "urgent", urgent: "high", routine: "medium" } as const;
const genderToFlabs = { male: "male", female: "female", other: "other" } as const;

type MappingPlan = { payload?: CreateLeadPayload; problems: string[]; mapped: string[]; unmapped: string[] };

/** Canonical order -> Flabs CreateLeadRequest. Pure function: no network, easy to test. */
export function buildLeadPayload(
  record: CanonicalRecord,
  options: { branchId: string; phase: "lead" | "booking" },
  catalog: CatalogTest[],
  mappings: FlabsMapping[]
): MappingPlan {
  const problems: string[] = [];
  const age = record.patient.birthDate ? ageInYears(record.patient.birthDate) : undefined;
  if (age === undefined) problems.push("date of birth missing or invalid (Flabs needs age)");
  const contact = tenDigitContact(record.patient.phone);
  if (!contact) problems.push("phone number is not 10 digits (Flabs needs contact)");
  const firstName = record.patient.givenName || record.patient.familyName;
  if (!firstName) problems.push("patient name missing");

  // Canonical order codes are LOINC after normalization, so match the catalog on LOINC first, then Healjour code.
  const code = record.order.code ?? "";
  const testEntry = catalog.find(t => t.loinc === code || t.code === code);
  const mapping = testEntry ? mappings.find(m => m.kind === "test" && m.healjourCode === testEntry.code) : undefined;

  const tests: Array<{ test: string; cost: number }> = [];
  const unmappedTests: Array<{ name: string; cost: number }> = [];
  const mapped: string[] = [];
  const unmapped: string[] = [];
  if (mapping) {
    tests.push({ test: mapping.flabsId, cost: mapping.flabsCost });
    mapped.push(mapping.healjourCode);
  } else if (code || record.order.display) {
    unmappedTests.push({ name: record.order.display || code, cost: 0 });
    unmapped.push(code || record.order.display || "unknown");
  } else {
    problems.push("order has no test code");
  }

  if (problems.length) return { problems, mapped, unmapped };

  const payload: CreateLeadPayload = {
    branchID: options.branchId,
    integratorID: record.recordId,
    phase: options.phase,
    first_name: firstName,
    ...(record.patient.familyName && record.patient.givenName ? { last_name: record.patient.familyName } : {}),
    contact,
    country_code: "91",
    age,
    age_type: "year",
    ...(record.patient.gender && record.patient.gender !== "unknown" ? { gender: genderToFlabs[record.patient.gender] } : {}),
    source: "healjour",
    priority: priorityToFlabs[record.order.priority ?? "routine"],
    tests,
    unmappedTests,
    totalAmount: tests.reduce((sum, t) => sum + t.cost, 0) + unmappedTests.reduce((sum, t) => sum + t.cost, 0),
    discountAmount: 0
  };
  if (options.phase === "booking") payload.paymentStatus = "Pending";
  return { payload, problems, mapped, unmapped };
}

export type FlabsAttempt = { ok: boolean; retryable: boolean; latencyMs: number; detail: string; notConfigured?: boolean };

/** One delivery attempt. The orchestrator decides retries; this only reports what Flabs said. */
export async function deliverToFlabs(record: CanonicalRecord, config: FlabsConfig | undefined): Promise<FlabsAttempt> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  if (!config || !config.branchId) {
    return { ok: false, retryable: false, latencyMs: 0, detail: "Flabs is not connected. Connect it from the Test Catalog screen.", notConfigured: true };
  }

  const store = getStore();
  const [catalog, mappings] = await Promise.all([store.listCatalogTests(), store.listFlabsMappings(config.id)]);
  const phase = config.phase;
  const plan = buildLeadPayload(record, { branchId: config.branchId, phase }, catalog, mappings);
  if (!plan.payload) {
    return { ok: false, retryable: false, latencyMs: elapsed(), detail: `Not sent to Flabs: ${plan.problems.join("; ")}.` };
  }

  try {
    const result = await createLead(config, plan.payload);
    if (result.duplicate) return { ok: true, retryable: false, latencyMs: elapsed(), detail: "Already in Flabs for today (409) - treated as synced." };
    // Lab accounts with "Auto pre-booking" on also get the pre-booking. Its outcome never fails the delivery.
    const code = record.order.code ?? "";
    const testEntry = catalog.find(t => t.loinc === code || t.code === code);
    const p = record.patient;
    const prebooking = await autoPrebook(config, {
      integratorId: record.recordId,
      first_name: p.givenName || p.familyName || "",
      last_name: p.givenName && p.familyName ? p.familyName : undefined,
      gender: p.gender && p.gender !== "unknown" ? genderToFlabs[p.gender] : undefined,
      age: (p.birthDate && ageInYears(p.birthDate)) || 0,
      age_type: "year",
      tests: testEntry ? [{ code: testEntry.code }] : [],
      packages: [],
      unmappedTests: testEntry ? [] : [record.order.display || code].filter(Boolean),
      unmappedPackages: []
    });
    const note = describeAutoPrebook(prebooking);
    return { ok: true, retryable: false, latencyMs: elapsed(), detail: `Created in Flabs as ${phase}${result.leadId ? ` (${result.leadId})` : ""}.${note ? ` ${note}` : ""}` };
  } catch (error) {
    if (error instanceof FlabsError) return { ok: false, retryable: error.retryable, latencyMs: elapsed(), detail: error.message };
    return { ok: false, retryable: true, latencyMs: elapsed(), detail: error instanceof Error ? error.message : "Unknown Flabs error." };
  }
}
