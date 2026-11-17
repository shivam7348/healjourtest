// Inbound Flabs webhooks: validate, de-duplicate, update the calendar, and log.
// The handler never throws to the caller: Flabs retries on non-2xx, so we always acknowledge
// once the event has been accepted, and record anything we could not act on.

import { randomBytes } from "node:crypto";
import { getStore } from "../store.js";
import { logIntegration } from "../logs.js";
import type { Appointment, FlabsTestResult } from "../models.js";

/** Flabs sends testData as [{ testName, status, parameter: [{ parameterName, value }] }]. */
function mapTestData(testData: any[]): FlabsTestResult[] {
  return testData.map(t => ({
    testName: String(t?.testName ?? "Test"),
    status: String(t?.status ?? ""),
    parameters: (Array.isArray(t?.parameter) ? t.parameter : []).map((p: any) => ({
      name: String(p?.parameterName ?? ""),
      value: p?.value === undefined || p?.value === null ? "" : String(p.value)
    }))
  }));
}

export const FLABS_EVENTS = [
  "lead.created",
  "booking.created",
  "booking.phlebotomist_assigned",
  "booking.phlebotomist_arrived",
  "booking.phlebotomist_sample_collected",
  "booking.phlebotomist_sample_submitted",
  "booking.rescheduled",
  "booking.cancelled",
  "bill.created",
  "bill.completed",
  "bill.deleted",
  "report.completed"
] as const;

/** Events that can create a tracker entry when Flabs tells us about a booking we did not create. */
const CREATES_BOOKING = ["lead.created", "booking.created", "bill.created", "bill.completed", "report.completed"];

/**
 * Test results: bill events carry them in billData.testData (with names and values),
 * report events in reportData.testData (statuses only). Only lists with names are results.
 */
function resultsOf(d: any): FlabsTestResult[] | undefined {
  const list = d?.billData?.testData ?? d?.reportData?.testData ?? d?.testData;
  if (!Array.isArray(list) || !list.length) return undefined;
  return list.some((t: any) => t?.testName) ? mapTestData(list) : undefined;
}

export type FlabsResultRecord = {
  id: string;                 // Flabs bill ID (or our integrator ID when Flabs did not send one)
  integratorID: string;
  leadId?: string;
  account: string;
  patientName: string;
  contact: string;
  reportUrl?: string;
  tests?: FlabsTestResult[];
  // Reference ranges read from the report PDF (see reportRanges.ts).
  refRanges?: Array<{ name: string; unit: string; low: number; high: number; labFlag?: "L" | "H" }>;
  refExtractedAt?: string;
  refError?: string;
  receivedAt: string;
  updatedAt: string;
};

/** Saves or updates one bill's results in the flabsResults table. Keeps the first receive time and any older values not sent again. */
export async function saveResultRecord(input: {
  id: string; integratorID: string; leadId?: string; account: string; patientName: string; contact: string;
  reportUrl?: string; tests?: FlabsTestResult[]; at: string;
}) {
  if (!input.id) return;
  const store = getStore();
  const existing = await store.docGet<FlabsResultRecord>("flabsResults", input.id);
  const record: FlabsResultRecord = {
    id: input.id,
    integratorID: input.integratorID,
    leadId: input.leadId ?? existing?.leadId,
    account: input.account,
    patientName: input.patientName || existing?.patientName || "",
    contact: input.contact || existing?.contact || "",
    reportUrl: input.reportUrl ?? existing?.reportUrl,
    tests: input.tests?.length ? input.tests : existing?.tests ?? [],
    // A new report link means the old ranges no longer describe it, so they are read again.
    ...(input.reportUrl && input.reportUrl !== existing?.reportUrl
      ? {}
      : { refRanges: existing?.refRanges, refExtractedAt: existing?.refExtractedAt, refError: existing?.refError }),
    receivedAt: existing?.receivedAt ?? input.at,
    updatedAt: input.at
  };
  await store.docPut("flabsResults", record);
}

export type FlabsEvent = {
  labID?: string;
  eventType: string;
  eventTime?: number;
  integratorID?: string;
  data?: Record<string, any>;
};

// Flabs may deliver the same event more than once. Remember recent keys to skip repeats.
const seen = new Map<string, number>();
const SEEN_LIMIT = 5000;

function dedupeKey(event: FlabsEvent) {
  const ref = event.data?.billID ?? event.data?.reportID ?? event.data?.leadID ?? event.data?.bookingID ?? event.integratorID ?? "";
  return `${event.eventType}|${event.eventTime ?? ""}|${ref}`;
}

function rememberOnce(key: string) {
  if (seen.has(key)) return false;
  seen.set(key, Date.now());
  if (seen.size > SEEN_LIMIT) {
    const oldest = seen.keys().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return true;
}

/** Which appointment status a booking event implies, if any. */
function statusFor(eventType: string): Appointment["status"] | undefined {
  switch (eventType) {
    case "booking.cancelled": return "cancelled";
    case "booking.phlebotomist_assigned": return "assigned";
    case "booking.phlebotomist_sample_submitted":
    case "bill.completed": return "done";
    default: return undefined;
  }
}

const TITLES: Record<string, string> = {
  "lead.created": "New lead from Flabs",
  "booking.created": "Booking created in Flabs",
  "booking.phlebotomist_assigned": "Phlebotomist assigned",
  "booking.phlebotomist_arrived": "Phlebotomist arrived",
  "booking.phlebotomist_sample_collected": "Sample collected",
  "booking.phlebotomist_sample_submitted": "Sample submitted to lab",
  "booking.rescheduled": "Booking rescheduled",
  "booking.cancelled": "Booking cancelled",
  "bill.created": "Bill created",
  "bill.completed": "Bill completed, report ready",
  "report.completed": "Report completed",
  "bill.deleted": "Bill deleted in Flabs"
};

/** Processes one accepted event. Returns what was done, for the response and the log. */
export async function handleFlabsEvent(accountLabel: string, event: FlabsEvent): Promise<"processed" | "duplicate" | "ignored"> {
  const key = dedupeKey(event);
  if (!rememberOnce(key)) return "duplicate";

  const store = getStore();
  const integratorID: string | undefined = event.integratorID ?? event.data?.integratorID;
  const status = statusFor(event.eventType);
  const title = TITLES[event.eventType] ?? `Flabs event: ${event.eventType}`;
  const patient = event.data?.patientData
    ? [event.data.patientData.firstName, event.data.patientData.lastName].filter(Boolean).join(" ")
    : event.data?.first_name ?? "";

  let note = "";
  if (integratorID) {
    const nowIso = new Date().toISOString();
    const apt = (await store.listAppointments()).find(a => a.integratorID === integratorID);
    const d = event.data ?? {};
    const billId = d.billID ?? d.reportID;
    const sampleImages = Array.isArray(d.sampleImages)
      ? d.sampleImages
          .map((s: any) => ({ url: String(s?.url ?? ""), lat: typeof s?.lat === "number" ? s.lat : null, lng: typeof s?.lng === "number" ? s.lng : null, capturedAt: s?.capturedAt ? String(s.capturedAt) : undefined }))
          .filter((s: { url: string }) => s.url)
      : [];
    const results = resultsOf(d);
    // Only what this event actually carries is written, so an older value is never wiped by an empty one.
    const common: Partial<Appointment> = {
      flabsEvent: title, flabsEventAt: nowIso,
      ...(billId ? { billId: String(billId) } : {}),
      ...(d.reportURL ? { reportUrl: String(d.reportURL), reportAt: nowIso } : {}),
      ...(sampleImages.length ? { sampleImages } : {}),
      ...(results ? { results } : {})
    };
    if (apt) {
      const patch: Partial<Appointment> = { ...common };
      if (status && apt.status !== status) {
        patch.status = status;
        note = `Calendar updated: ${status}.`;
      }
      await store.saveAppointment({ ...apt, ...patch, updatedAt: nowIso });
    } else if (CREATES_BOOKING.includes(event.eventType)) {
      // A booking made directly in Flabs: add it to the tracker so every booking is visible.
      const p = d.patientData ?? {};
      const name = d.patientData ? [p.firstName, p.lastName].filter(Boolean).join(" ") : String(d.first_name ?? "");
      await store.saveAppointment({
        id: `apt-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
        integratorID, leadId: d.leadID ? String(d.leadID) : undefined, account: accountLabel,
        patientName: name, contact: String(p.contact ?? ""),
        tests: (results ?? []).map(r => r.testName),
        status: status ?? "unassigned", createdAt: nowIso, updatedAt: nowIso,
        ...common
      });
      note = "Added to the tracker from Flabs.";
    } else if (status) {
      note = "No matching booking in Healjour, so the calendar was not changed.";
    }
  }

  // Results and report links are also kept in their own table (flabsResults) for the Results tool.
  const resultList = resultsOf(event.data);
  if (integratorID && (resultList || event.data?.reportURL)) {
    await saveResultRecord({
      id: String(event.data?.billID ?? event.data?.reportID ?? integratorID),
      integratorID, leadId: event.data?.leadID ? String(event.data.leadID) : undefined,
      account: accountLabel, patientName: patient, contact: String(event.data?.patientData?.contact ?? ""),
      reportUrl: event.data?.reportURL ? String(event.data.reportURL) : undefined,
      tests: resultList, at: new Date().toISOString()
    });
  }

  await logIntegration({
    type: "webhook",
    status: event.eventType === "booking.cancelled" ? "error" : "success",
    account: accountLabel,
    title,
    message: note || `Received from Flabs${patient ? ` for ${patient}` : ""}.`,
    integratorID,
    leadId: event.data?.leadID ?? event.data?.billID,
    details: [
      `Event: ${event.eventType}`,
      event.eventTime ? `Flabs time: ${new Date(event.eventTime * 1000).toISOString()}` : "",
      event.data?.billID ? `Bill: ${event.data.billID}` : "",
      event.data?.reportURL ? `Report: ${event.data.reportURL}` : ""
    ].filter(Boolean)
  });
  return status || note ? "processed" : "ignored";
}
