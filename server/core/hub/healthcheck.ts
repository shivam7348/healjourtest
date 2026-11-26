// Daily booking health check. Every day at 10:00 IST it sends clearly marked TEST bookings to the
// destinations a Super Admin ticked as "test" (nothing is ticked by default), measures each call, and
// raises a critical alert when a destination fails.
//
// Destinations   Flabs account × billing (pre-booking) and/or lead/booking (per the account's phase),
//                and partner labs (Lab Portal cases).
// Clean-up       Lab Portal test cases are cancelled at once. Flabs has no cancel API: test bills and leads
//                stay in that Flabs account, named "HEALJOUR TEST", which is why only test accounts are used.
// Schedule       Run by the scheduler (scheduler.ts): daily 10:00 IST, on/off switch, once per day.

import { getStore } from "../store.js";
import { newId } from "../framework/connector.js";
import { raiseAlert } from "./alerts.js";
import { allFlabsConfigs, getFlabsConfig } from "../flabs/connection.js";
import { bookingSchema, sendBooking } from "../flabs/booking.js";
import { checkAgainstSettings, emptyPrebookingSettings, preBookingSchema, sendPreBooking } from "../flabs/prebooking.js";
import { LABS, type PortalLab } from "../portal/auth.js";
import { logIntegration } from "../logs.js";
import { apiBooking, caseNo, CASES, newId as caseId, recordLabUpdate, type LabCase } from "../../portal-routes.js";
import { emitEvent } from "../devplatform/webhooks.js";
import type { JobRun } from "./jobs.js";

export type HealthCheckSettings = {
  id: "default";
  enabled: boolean;
  perDestination: number;                                          // 1-10
  flabs: Array<{ connectionId: string; billing: boolean; booking: boolean }>;
  labIds: string[];
  updatedAt?: string; updatedBy?: string;
};
const SETTINGS = "healthCheckSettings";
const RUNS = "jobRuns";
export const HEALTHCHECK_HOUR_IST = 10;
const TEST_NAME = "HEALJOUR TEST";
const TEST_NOTE = "Automated daily health check by Healjour. Not a real patient: please ignore or cancel.";

export async function getHealthCheckSettings(): Promise<HealthCheckSettings> {
  const s = await getStore().docGet<HealthCheckSettings>(SETTINGS, "default");
  return { id: "default", enabled: false, perDestination: 10, flabs: [], labIds: [], ...(s ?? {}) };
}
export async function saveHealthCheckSettings(next: Omit<HealthCheckSettings, "id">) {
  await getStore().docPut<HealthCheckSettings>(SETTINGS, { id: "default", ...next, perDestination: Math.min(10, Math.max(1, Math.round(next.perDestination))) });
}

const istDate = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);   // YYYY-MM-DD in IST

type Outcome = { ok: boolean; ms: number; error?: string; ref?: string };
function summarize(name: string, outcomes: Outcome[]) {
  const okCount = outcomes.filter(o => o.ok).length;
  const avg = outcomes.length ? Math.round(outcomes.reduce((n, o) => n + o.ms, 0) / outcomes.length) : 0;
  const firstError = outcomes.find(o => !o.ok)?.error;
  return { name, ok: outcomes.length > 0 && okCount === outcomes.length, summary: `${okCount}/${outcomes.length} OK · avg ${avg} ms${firstError ? ` · first error: ${firstError}` : ""}` };
}
async function timed(fn: () => Promise<string | undefined>): Promise<Outcome> {
  const t = Date.now();
  try { const ref = await fn(); return { ok: true, ms: Date.now() - t, ref }; }
  catch (e) { return { ok: false, ms: Date.now() - t, error: e instanceof Error ? e.message.slice(0, 200) : "Failed" }; }
}
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A Healjour test code this Flabs account can send (mapped to a Flabs test). */
async function mappedTestFor(connectionId: string) {
  const m = (await getStore().listFlabsMappings(connectionId)).find(x => x.kind === "test");
  return m?.healjourCode ?? null;
}

async function checkFlabs(connectionId: string, kind: "billing" | "booking", count: number, day: string): Promise<JobRun["steps"][number]> {
  const config = getFlabsConfig(connectionId);
  const label = config?.label ?? connectionId;
  const name = `Flabs ${kind === "billing" ? "billing (pre-booking)" : `${config?.phase ?? "lead/booking"}`} · ${label}`;
  if (!config) return { name, ok: false, summary: "Account not connected any more." };
  const code = await mappedTestFor(connectionId);
  if (!code) return { name, ok: false, summary: "No test is mapped for this account (Test Catalog → mapping)." };
  const outcomes: Outcome[] = [];
  for (let i = 1; i <= count; i++) {
    const ref = `HJTEST-${day.replace(/-/g, "")}-${connectionId.slice(-6)}-${kind === "billing" ? "B" : "L"}${i}`;
    if (kind === "billing") {
      const settings = (await getStore().getPrebookingSettings(config.id)) ?? emptyPrebookingSettings(config.id);
      const leadSource = settings.defaultLeadSource || settings.leadSources[0];
      // Flabs only accepts lead sources it gave this lab, so we cannot pick one ourselves.
      if (!leadSource) return { name, ok: false, summary: "Not sent: this account has no lead source. Add the lead source Flabs gave this lab in Orders & Bookings → Pre-booking → Pre-booking setup, then run again." };
      outcomes.push(await timed(async () => {
        const input = preBookingSchema.parse({
          connectionId, integrator_id: ref, lead_source: leadSource, first_name: TEST_NAME, last_name: `Health check ${i}`,
          gender: "male", age: 30, age_type: "year", rate_list_type: settings.defaultRateListType || undefined, tests: [{ code }]
        });
        const problems = checkAgainstSettings(input, settings);
        if (problems.length) throw new Error(problems.join(" "));
        const r = await sendPreBooking(config, input);
        return r.preBookingID ?? r.integratorId;
      }));
    } else {
      outcomes.push(await timed(async () => {
        const input = bookingSchema.parse({
          connectionId, integratorID: ref, first_name: TEST_NAME, last_name: `Health check ${i}`, contact: "9000000000",
          age: 30, age_type: "year", gender: "male", tests: [{ code }], bookingType: "Lab Visit", specialInstructions: TEST_NOTE
        });
        const r = await sendBooking(config, input);
        return r.leadId ?? r.integratorID;
      }));
    }
    await pause(250);   // gentle on the lab's Flabs account
  }
  await logIntegration({
    type: "booking", status: outcomes.every(o => o.ok) ? "success" : "error", account: label,
    title: `Daily health check: ${kind === "billing" ? "billing" : "lead/booking"}`,
    message: `${outcomes.filter(o => o.ok).length} of ${outcomes.length} test ${kind === "billing" ? "bills" : "bookings"} accepted by Flabs.`,
    details: outcomes.map((o, n) => `#${n + 1}: ${o.ok ? `OK ${o.ms} ms ${o.ref ?? ""}` : `FAILED ${o.error}`}`)
  });
  return summarize(name, outcomes);
}

async function checkLab(labId: string, count: number): Promise<JobRun["steps"][number]> {
  const store = getStore();
  const lab = await store.docGet<PortalLab>(LABS, labId);
  const name = `Partner lab cases · ${lab?.name ?? labId}`;
  if (!lab) return { name, ok: false, summary: "Lab not found any more." };
  if (!lab.active) return { name, ok: false, summary: "Lab is paused." };
  const test = (await store.listCatalogTests()).find(t => t.active);
  const outcomes: Outcome[] = [];
  for (let i = 1; i <= count; i++) {
    outcomes.push(await timed(async () => {
      const now = new Date().toISOString();
      const c: LabCase = {
        id: caseId("case"), caseNo: caseNo(), labId: lab.id, labName: lab.name,
        patient: { name: `${TEST_NAME} · Health check ${i}`, age: 30, ageUnit: "year", gender: "male" },
        tests: test ? [{ code: test.code, name: test.name }] : [{ code: "TEST", name: "Health check" }],
        priority: "routine", collection: "lab_visit", notes: TEST_NOTE, status: "new", results: [], reports: [],
        timeline: [{ at: now, by: "Healjour health check", role: "system", action: "Test booking sent to lab", status: "new" }],
        createdAt: now, createdBy: "system:healthcheck", updatedAt: now, adminSeenAt: now
      };
      await store.docPut(CASES, c);
      void emitEvent("booking.created", { booking: apiBooking(c), healthCheck: true }, { labId: lab.id });
      // Cancelled straight away, so it never sits in the lab's open work.
      c.status = "cancelled";
      await recordLabUpdate(c, { name: "Healjour health check", email: "system:healthcheck", role: "api" }, "New → Cancelled", { status: "cancelled", note: "Automated health check: cancelled immediately." });
      const back = await store.docGet<LabCase>(CASES, c.id);
      if (!back || back.status !== "cancelled") throw new Error("The test case did not save correctly.");
      return c.caseNo;
    }));
  }
  return summarize(name, outcomes);
}

/** Runs the check now. The scheduler (scheduler.ts) decides when, and keeps it to once a day. */
export async function runHealthCheck(trigger: string): Promise<JobRun> {
  const store = getStore();
  const settings = await getHealthCheckSettings();
  const day = istDate();
  const started = Date.now();
  const count = settings.perDestination;
  const known = new Set(allFlabsConfigs().map(c => c.id));
  // Destinations run side by side; calls to one destination run one after another.
  const jobs: Array<Promise<JobRun["steps"][number]>> = [];
  for (const f of settings.flabs.filter(x => known.has(x.connectionId))) {
    if (f.billing) jobs.push(checkFlabs(f.connectionId, "billing", count, day));
    if (f.booking) jobs.push(checkFlabs(f.connectionId, "booking", count, day));
  }
  for (const labId of settings.labIds) jobs.push(checkLab(labId, count));
  const steps = jobs.length ? await Promise.all(jobs) : [{ name: "Destinations", ok: true, summary: "No test destinations ticked. Nothing was sent." }];
  const run: JobRun = { id: newId("job"), at: new Date().toISOString(), job: "healthcheck", trigger, ok: steps.every(s => s.ok), durationMs: Date.now() - started, steps };
  await store.docPut(RUNS, run);
  for (const s of steps.filter(x => !x.ok)) {
    await raiseAlert({ key: `healthcheck:${s.name}`, severity: "critical", source: "healthcheck", runbook: "failure-rate", title: `Daily health check failed: ${s.name}`, detail: s.summary });
  }
  return run;
}

export const listHealthCheckRuns = async () => (await getStore().docList<JobRun>(RUNS, { job: "healthcheck" })).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30);
