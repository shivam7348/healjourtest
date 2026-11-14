// Pre-booking: starts Flabs' billing workflow (POST /client/billing/create).
// Unlike a lead/booking it needs the lab ID, gender and a lead source, and returns a preBookingID.
// Tests and packages come from Healjour's catalog; mapped ones go by Flabs ID, the rest by name.

import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { CatalogPackage, CatalogTest, FlabsMapping, FlabsPrebookingSettings } from "../models.js";
import { getStore } from "../store.js";
import { createPreBooking, type CreatePreBookingPayload, type FlabsConfig } from "./client.js";

const optionalText = (max: number) => z.string().trim().max(max).optional().transform(v => v || undefined);

export const preBookingSchema = z.object({
  connectionId: z.string().min(1),
  integrator_id: z.string().trim().min(1).max(120).optional(),
  lead_source: z.string().trim().min(1, "Lead source is required (ask Flabs for the allowed values).").max(80),

  first_name: z.string().trim().min(1, "First name is required.").max(80),
  last_name: optionalText(80),
  gender: z.enum(["male", "female", "other"], { errorMap: () => ({ message: "Choose a gender." }) }),
  age: z.number({ invalid_type_error: "Enter age as a number." }).int("Age must be a whole number.").min(0).max(150),
  age_type: z.enum(["year", "month", "day"]),

  barCode: optionalText(60),
  doctor: optionalText(64),
  hospital: optionalText(64),
  rate_list_type: optionalText(60),

  tests: z.array(z.object({ code: z.string().min(1).max(30) })).default([]),
  packages: z.array(z.object({ code: z.string().min(1).max(30) })).default([]),
  unmappedTests: z.array(z.string().trim().min(1).max(120)).default([]),
  unmappedPackages: z.array(z.string().trim().min(1).max(120)).default([]),
  unmappedPackagesWithTests: z.array(z.object({
    package_name: z.string().trim().min(1).max(120),
    tests: z.array(z.string().trim().min(1).max(120)).min(1)
  })).default([])
}).refine(v => v.tests.length + v.packages.length + v.unmappedTests.length + v.unmappedPackages.length + v.unmappedPackagesWithTests.length > 0, {
  message: "Choose at least one test or package."
});

export type PreBookingInput = z.infer<typeof preBookingSchema>;

// Pre-booking setup per Flabs account: the values Flabs gave this lab, entered once and picked from lists afterwards.
const referralSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  flabsId: z.string().trim().min(1, "Flabs ID is required.").max(64)
});
const valueList = z.array(z.string().trim().min(1).max(80)).max(50)
  .transform(list => [...new Set(list)]);

export const prebookingSettingsSchema = z.object({
  leadSources: valueList.default([]),
  rateListTypes: valueList.default([]),
  doctors: z.array(referralSchema).max(500).default([]),
  hospitals: z.array(referralSchema).max(500).default([])
});

export const emptyPrebookingSettings = (connectionId: string): FlabsPrebookingSettings => ({
  connectionId, leadSources: [], rateListTypes: [], doctors: [], hospitals: [], updatedAt: new Date(0).toISOString()
});

/**
 * Checks a pre-booking against the account's setup: once a list is filled in, only its values are allowed,
 * so a typo never reaches Flabs. Empty lists allow any value (lead source) or none (doctor, hospital).
 */
export function checkAgainstSettings(input: PreBookingInput, settings: FlabsPrebookingSettings): string[] {
  const errors: string[] = [];
  if (settings.leadSources.length && !settings.leadSources.includes(input.lead_source)) {
    errors.push(`Lead source must be one of: ${settings.leadSources.join(", ")}.`);
  }
  if (input.rate_list_type && settings.rateListTypes.length && !settings.rateListTypes.includes(input.rate_list_type)) {
    errors.push(`Rate list type must be one of: ${settings.rateListTypes.join(", ")}.`);
  }
  if (input.doctor && !settings.doctors.some(d => d.flabsId === input.doctor)) {
    errors.push("Choose the referring doctor from the mapped list (Pre-booking setup).");
  }
  if (input.hospital && !settings.hospitals.some(h => h.flabsId === input.hospital)) {
    errors.push("Choose the referring hospital from the mapped list (Pre-booking setup).");
  }
  return errors;
}

export type BuiltPreBooking = {
  payload: CreatePreBookingPayload;
  mappedTests: string[];
  unmappedTests: string[];
  mappedPackages: string[];
  unmappedPackages: string[];
};

/** Builds the exact body Flabs expects. Pure function: no network, easy to check. */
export function buildPreBookingPayload(
  input: PreBookingInput,
  config: FlabsConfig,
  catalog: { tests: CatalogTest[]; packages: CatalogPackage[] },
  mappings: FlabsMapping[]
): BuiltPreBooking {
  if (!config.branchId) throw new Error("This Flabs account has no lab (branch) selected. Edit the account and choose one.");

  const testByCode = new Map(catalog.tests.map(t => [t.code, t]));
  const packageByCode = new Map(catalog.packages.map(p => [p.code, p]));
  const testMap = new Map(mappings.filter(m => m.kind === "test").map(m => [m.healjourCode, m]));
  const packageMap = new Map(mappings.filter(m => m.kind === "package").map(m => [m.healjourCode, m]));

  const mapped_tests: Array<{ id: string }> = [];
  const unmapped_tests: string[] = [];
  const mappedTests: string[] = [];
  const unmappedTests: string[] = [];
  for (const { code } of input.tests) {
    const mapping = testMap.get(code);
    if (mapping) {
      mapped_tests.push({ id: mapping.flabsId });
      mappedTests.push(code);
    } else {
      // Not mapped to this account: Flabs gets the test by name and resolves it on its side.
      unmapped_tests.push(testByCode.get(code)?.name ?? code);
      unmappedTests.push(code);
    }
  }
  unmapped_tests.push(...input.unmappedTests);

  const mapped_packages: Array<{ id: string }> = [];
  const unmapped_packages: string[] = [];
  const mappedPackages: string[] = [];
  const unmappedPackages: string[] = [];
  for (const { code } of input.packages) {
    const mapping = packageMap.get(code);
    if (mapping) {
      mapped_packages.push({ id: mapping.flabsId });
      mappedPackages.push(code);
    } else {
      unmapped_packages.push(packageByCode.get(code)?.name ?? code);
      unmappedPackages.push(code);
    }
  }
  unmapped_packages.push(...input.unmappedPackages);

  const patient_details: Record<string, unknown> = {
    first_name: input.first_name,
    gender: input.gender,
    age: input.age,
    age_type: input.age_type
  };
  if (input.last_name) patient_details.last_name = input.last_name;

  const payload: CreatePreBookingPayload = {
    labID: config.branchId,
    patient_details,
    integrator_id: input.integrator_id ?? `HJ-PB-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
    lead_source: input.lead_source
  };
  // Send each list only when it has something, and optional fields only when filled.
  if (mapped_tests.length) payload.mapped_tests = mapped_tests;
  if (unmapped_tests.length) payload.unmapped_tests = unmapped_tests;
  if (mapped_packages.length) payload.mapped_packages = mapped_packages;
  if (unmapped_packages.length) payload.unmapped_packages = unmapped_packages;
  if (input.unmappedPackagesWithTests.length) payload.unmapped_packages_with_tests = input.unmappedPackagesWithTests;
  for (const key of ["barCode", "doctor", "hospital", "rate_list_type"] as const) {
    if (input[key]) payload[key] = input[key];
  }

  return { payload, mappedTests, unmappedTests, mappedPackages, unmappedPackages };
}

export type PreBookingResult = {
  integratorId: string;
  preBookingID?: string;
  message?: string;
  mappedTests: string[];
  unmappedTests: string[];
  mappedPackages: string[];
  unmappedPackages: string[];
};

/** Sends the pre-booking to the chosen Flabs account. Throws FlabsError when Flabs rejects it. */
export async function sendPreBooking(config: FlabsConfig, input: PreBookingInput): Promise<PreBookingResult> {
  const store = getStore();
  const [tests, packages, mappings] = await Promise.all([
    store.listCatalogTests(), store.listCatalogPackages(), store.listFlabsMappings(config.id)
  ]);
  const built = buildPreBookingPayload(input, config, { tests, packages }, mappings);
  const result = await createPreBooking(config, built.payload);
  return {
    integratorId: String(built.payload.integrator_id),
    preBookingID: result.preBookingID,
    message: result.message,
    mappedTests: built.mappedTests,
    unmappedTests: built.unmappedTests,
    mappedPackages: built.mappedPackages,
    unmappedPackages: built.unmappedPackages
  };
}
