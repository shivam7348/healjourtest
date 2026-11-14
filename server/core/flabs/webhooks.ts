// Inbound Flabs webhooks: validate, de-duplicate, update the calendar, and log.
// The handler never throws to the caller: Flabs retries on non-2xx, so we always acknowledge
// once the event has been accepted, and record anything we could not act on.

import { getStore } from "../store.js";
import { logIntegration } from "../logs.js";
import type { Appointment } from "../models.js";

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
  "report.completed"
] as const;

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
  const ref = event.data?.billID ?? event.data?.leadID ?? event.data?.bookingID ?? event.integratorID ?? "";
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
  "report.completed": "Report completed"
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
  if (integratorID && status) {
    const apt = (await store.listAppointments()).find(a => a.integratorID === integratorID);
    if (apt && apt.status !== status) {
      await store.saveAppointment({ ...apt, status, updatedAt: new Date().toISOString() });
      note = `Calendar updated: ${status}.`;
    } else if (!apt) {
      note = "No matching booking in Healjour, so the calendar was not changed.";
    }
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
