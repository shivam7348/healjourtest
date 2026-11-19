// Manual lead/booking entry: a staff member fills the Flabs form in Healjour and it is
// sent to a chosen Flabs account. Field names and enums follow Flabs' Create Lead API.
// Tests and packages are picked from Healjour's catalog; anything not mapped to the
// account goes out as unmappedTests / unmappedPackages so Flabs can resolve it later.

import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { CatalogPackage, CatalogTest, FlabsMapping } from "../models.js";
import { getStore } from "../store.js";
import { createLead, FlabsError, type CreateLeadPayload, type FlabsConfig } from "./client.js";

const optionalText = (max: number) => z.string().trim().max(max).optional();

export const bookingSchema = z.object({
  connectionId: z.string().min(1),

  // Required by Flabs. integratorID is generated when left empty; it is echoed back in webhooks.
  integratorID: z.string().trim().min(1).max(120).optional(),
  branchID: z.string().optional(), // ignored: the branch always comes from the chosen connection
  first_name: z.string().trim().min(1, "First name is required.").max(80),
  contact: z.string().regex(/^\d{10}$/, "Contact must be exactly 10 digits."),
  age: z.number({ invalid_type_error: "Enter age as a number." }).min(0).max(150),
  age_type: z.enum(["year", "month", "day"]),

  phase: z.enum(["lead", "booking"]).optional(),
  designation: optionalText(20),
  last_name: optionalText(80),
  country_code: z.string().trim().regex(/^\d{1,4}$/).default("91"),
  email: z.string().trim().email("Email is not valid.").optional().or(z.literal("")),
  gender: z.enum(["male", "female", "other"]).optional(),
  weight: z.number().positive().max(500).optional(),
  height: z.number().positive().max(300).optional(),
  address: optionalText(300),
  pincode: optionalText(10),
  googleLocation: optionalText(200),
  aadhaar_number: optionalText(20),
  insurance_number: optionalText(40),
  uhid: optionalText(40),
  passport_number: optionalText(20),
  owner_name: optionalText(80),
  breed: optionalText(60),
  category: optionalText(60),
  source: optionalText(60),
  priority: z.enum(["urgent", "high", "medium", "low"]).optional(),

  // Party: corporate, referring doctor or referring hospital. The connection's own party wins if set.
  corporateUser: optionalText(64),
  referredOrganization: optionalText(64),
  referredHospitalOrganization: optionalText(64),

  tests: z.array(z.object({ code: z.string().min(1).max(30) })).default([]),
  packages: z.array(z.object({ code: z.string().min(1).max(30) })).default([]),
  unmappedTests: z.array(z.object({ name: z.string().trim().min(1).max(120), cost: z.number().min(0).default(0) })).default([]),
  unmappedPackages: z.array(z.object({ name: z.string().trim().min(1).max(120), price: z.number().min(0).default(0) })).default([]),

  discountAmount: z.number().min(0).default(0),
  totalAmount: z.number().min(0).optional(),
  bookingType: z.enum(["Home Collection", "Lab Visit"]).optional(),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  specialInstructions: optionalText(500),
  paymentStatus: z.enum(["Pending", "Paid", "Pay Later"]).optional(),
  paymentMode: z.enum(["Razorpay UPI", "Card", "Cash"]).optional(),
  customFields: z.record(z.union([z.string(), z.number(), z.boolean()])).optional()
}).refine(v => v.tests.length + v.packages.length + v.unmappedTests.length + v.unmappedPackages.length > 0, {
  message: "Choose at least one test or package."
});

export type BookingInput = z.infer<typeof bookingSchema>;

const PARTY_FIELDS = ["corporateUser", "referredOrganization", "referredHospitalOrganization"] as const;

/** Builds the exact body Flabs expects. Pure function: no network, easy to check. */
export function buildBookingPayload(
  input: BookingInput,
  config: FlabsConfig,
  catalog: { tests: CatalogTest[]; packages: CatalogPackage[] },
  mappings: FlabsMapping[]
): { payload: CreateLeadPayload; mappedTests: string[]; unmappedTests: string[]; mappedPackages: string[]; unmappedPackages: string[] } {
  const testByCode = new Map(catalog.tests.map(t => [t.code, t]));
  const packageByCode = new Map(catalog.packages.map(p => [p.code, p]));
  const testMap = new Map(mappings.filter(m => m.kind === "test").map(m => [m.healjourCode, m]));
  const packageMap = new Map(mappings.filter(m => m.kind === "package").map(m => [m.healjourCode, m]));

  const tests: Array<{ test: string; cost: number }> = [];
  const unmappedTests: Array<{ name: string; cost: number }> = [];
  const mappedTests: string[] = [];
  const unmappedTestNames: string[] = [];
  for (const { code } of input.tests) {
    const catalogTest = testByCode.get(code);
    const mapping = testMap.get(code);
    if (mapping) {
      tests.push({ test: mapping.flabsId, cost: mapping.flabsCost });
      mappedTests.push(code);
    } else {
      // Not mapped to this account: send by name and the Healjour price so the lead still goes through.
      unmappedTests.push({ name: catalogTest?.name ?? code, cost: catalogTest?.price ?? 0 });
      unmappedTestNames.push(code);
    }
  }
  unmappedTests.push(...input.unmappedTests.map(t => ({ name: t.name, cost: t.cost })));

  const packages: Array<{ package: string; price: number }> = [];
  const unmappedPackages: Array<{ name: string; price: number }> = [];
  const mappedPackages: string[] = [];
  const unmappedPackageNames: string[] = [];
  for (const { code } of input.packages) {
    const catalogPackage = packageByCode.get(code);
    const mapping = packageMap.get(code);
    if (mapping) {
      packages.push({ package: mapping.flabsId, price: catalogPackage?.price ?? mapping.flabsCost });
      mappedPackages.push(code);
    } else {
      unmappedPackages.push({ name: catalogPackage?.name ?? code, price: catalogPackage?.price ?? 0 });
      unmappedPackageNames.push(code);
    }
  }
  unmappedPackages.push(...input.unmappedPackages.map(p => ({ name: p.name, price: p.price })));

  const computedTotal =
    tests.reduce((sum, t) => sum + t.cost, 0) + unmappedTests.reduce((sum, t) => sum + t.cost, 0) +
    packages.reduce((sum, p) => sum + p.price, 0) + unmappedPackages.reduce((sum, p) => sum + p.price, 0);

  // Flat Flabs fields, copied only when the form filled them so empty values are not sent.
  const flat: CreateLeadPayload = {};
  const copy = (key: string, value: unknown) => { if (value !== undefined && value !== "") flat[key] = value; };
  for (const key of ["designation", "last_name", "country_code", "email", "gender", "weight", "height", "address", "pincode",
    "googleLocation", "aadhaar_number", "insurance_number", "uhid", "passport_number", "owner_name", "breed", "category",
    "source", "priority", "bookingType", "scheduledAt", "specialInstructions", "paymentStatus", "paymentMode", "customFields"] as const) {
    copy(key, (input as Record<string, unknown>)[key]);
  }

  // A connection with its own party overrides whatever the form says; otherwise the form's party is used.
  // A corporate is separate from a referring doctor/hospital, so it can still be chosen on such an account.
  if (!config.party) {
    for (const field of PARTY_FIELDS) copy(field, (input as Record<string, unknown>)[field]);
  } else if (config.party.field !== "corporateUser") {
    copy("corporateUser", input.corporateUser);
  }

  const payload: CreateLeadPayload = {
    ...flat,
    branchID: config.branchId,
    integratorID: input.integratorID ?? `HJ-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
    phase: input.phase ?? config.phase,
    first_name: input.first_name,
    contact: input.contact,
    age: input.age,
    age_type: input.age_type,
    tests,
    unmappedTests,
    packages,
    unmappedPackages,
    discountAmount: input.discountAmount,
    totalAmount: input.totalAmount ?? computedTotal
  };
  if (!payload.source) payload.source = "healjour";
  return { payload, mappedTests, unmappedTests: unmappedTestNames, mappedPackages, unmappedPackages: unmappedPackageNames };
}

export type BookingResult = {
  integratorID: string;
  phase: string;
  duplicate: boolean;
  leadId?: string;
  mappedTests: string[];
  unmappedTests: string[];
  mappedPackages: string[];
  unmappedPackages: string[];
};

/** Sends the booking to the chosen Flabs account. Throws FlabsError on rejection. */
export async function sendBooking(config: FlabsConfig, input: BookingInput): Promise<BookingResult> {
  const store = getStore();
  const [tests, packages, mappings] = await Promise.all([
    store.listCatalogTests(), store.listCatalogPackages(), store.listFlabsMappings(config.id)
  ]);
  const built = buildBookingPayload(input, config, { tests, packages }, mappings);
  const result = await createLead(config, built.payload);
  return {
    integratorID: String(built.payload.integratorID),
    phase: String(built.payload.phase),
    duplicate: result.duplicate,
    leadId: result.leadId,
    mappedTests: built.mappedTests,
    unmappedTests: built.unmappedTests,
    mappedPackages: built.mappedPackages,
    unmappedPackages: built.unmappedPackages
  };
}

export { FlabsError };
