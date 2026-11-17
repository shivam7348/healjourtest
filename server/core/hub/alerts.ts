// Alerts and runbooks (reliability ops).
// Anything that needs a person (a dead letter, a reconciliation mismatch, failed reminders, stale leads)
// raises an alert. The same problem raises one alert, not many: repeats bump its count while it is open.
// New alerts are posted to the ops channel (Slack, or the sandbox channel) and appear in the admin bell.

import { getStore } from "../store.js";
import { callConnector, newId, onDeadLetter } from "../framework/connector.js";

export type Severity = "critical" | "warning" | "info";
export type Alert = {
  id: string; key: string; at: string; lastAt: string; count: number;
  severity: Severity; source: string; title: string; detail: string; runbook: string;
  status: "open" | "acknowledged" | "resolved"; resolvedAt?: string; by?: string;
};

const ALERTS = "alerts";

export const RUNBOOKS: Record<string, { title: string; when: string; steps: string[] }> = {
  "dead-letter": {
    title: "A partner call is in dead letters",
    when: "A call to a partner still failed after every retry.",
    steps: [
      "Open Connector Framework → Dead letters and read the error.",
      "HTTP 5xx, 429 or a timeout: the partner was down or slow. Check their status page, then Replay.",
      "HTTP 400: the partner rejected the data. Fix the record or the mapping (test it in Mapping playground), then send again. Do not replay unchanged data.",
      "HTTP 401/403 or 'Missing credential': update the key on the server, redeploy, then Replay.",
      "Replay is safe: the same idempotency key is sent, so nothing is created twice."
    ]
  },
  "failure-rate": {
    title: "A connector is failing often",
    when: "More than 20 % of a connector's calls failed in the last hour.",
    steps: [
      "Open Connector Framework → Call log, filter by the connector, look at the status codes.",
      "Many 429s: lower the connector's rate limit or ask the partner for a higher quota.",
      "Many 5xx or timeouts: the partner is degraded. Tell their support, share correlation IDs from the log.",
      "Many 401s: the credential expired or was rotated. Update it on the server."
    ]
  },
  "reconciliation": {
    title: "Payments do not match the settlement report",
    when: "The daily reconciliation found a payment missing from settlements, a settlement we do not know, or a different amount.",
    steps: [
      "Open Integration Hub → Payments → Reconciliation and open the latest run.",
      "Missing in settlement: payments settle T+1 or T+2. If it is older than 3 days, raise it with the gateway with the payment ID.",
      "Unknown settlement: find the payment in the gateway dashboard; record it in Healjour if it is ours.",
      "Amount differs: compare with refunds and chargebacks for that payment; record the reason.",
      "Mark the alert resolved with a short note once explained."
    ]
  },
  "message-failures": {
    title: "Patient messages are failing",
    when: "SMS or email to patients failed in the last day.",
    steps: [
      "Open Integration Hub → Communication → Messages, filter Failed.",
      "Invalid number or DND: correct the patient's number; DND numbers need the transactional route.",
      "Provider errors: check the provider status; failed SMS already fell back to email when the patient has one.",
      "Resend from the message row once fixed."
    ]
  },
  "stale-leads": {
    title: "Leads waiting too long",
    when: "Leads are still 'new' 24 hours after they arrived.",
    steps: [
      "Open Integration Hub → Leads, filter New.",
      "Call or message each lead and update its status (contacted, booked or lost).",
      "If one source sends many junk leads, check that source's form and targeting with marketing."
    ]
  },
  "missing-report": {
    title: "Bookings without a report",
    when: "A lab booking is older than 48 hours and no report has arrived.",
    steps: [
      "Open Orders & Bookings → Tracker and find the booking.",
      "Check its last Flabs event. No events at all: check that webhooks are registered for that account.",
      "Ask the lab about the sample. If the bill exists in Flabs, the report webhook may have failed: check Transactions & Logs."
    ]
  }
};

/** Raises (or bumps) an alert. Posts new alerts to the ops channel. Never throws. */
export async function raiseAlert(input: { key: string; severity: Severity; source: string; title: string; detail: string; runbook: string }) {
  try {
    const store = getStore();
    const open = (await store.docList<Alert>(ALERTS, { key: input.key })).find(a => a.status !== "resolved");
    const now = new Date().toISOString();
    if (open) {
      await store.docPut(ALERTS, { ...open, lastAt: now, count: open.count + 1, detail: input.detail, severity: input.severity });
      return open.id;
    }
    const alert: Alert = { id: newId("alert"), at: now, lastAt: now, count: 1, status: "open", ...input };
    await store.docPut(ALERTS, alert);
    await callConnector("slack-alerts", "post", {
      body: { text: `[${input.severity.toUpperCase()}] ${input.title}\n${input.detail}\nRunbook: ${RUNBOOKS[input.runbook]?.title ?? input.runbook}` },
      idempotencyKey: `alert-${alert.id}`
    });
    return alert.id;
  } catch (e) {
    console.warn("Could not raise alert:", e instanceof Error ? e.message : e);
    return null;
  }
}

export async function setAlertStatus(id: string, status: "acknowledged" | "resolved", by: string) {
  const store = getStore();
  const a = await store.docGet<Alert>(ALERTS, id);
  if (!a) return null;
  const next: Alert = { ...a, status, by, ...(status === "resolved" ? { resolvedAt: new Date().toISOString() } : {}) };
  await store.docPut(ALERTS, next);
  return next;
}

export const listAlerts = async () => (await getStore().docList<Alert>(ALERTS)).sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, 300);

// Every call that ends in dead letters raises an alert (except the alert channel itself, to avoid a loop).
onDeadLetter(async dl => {
  if (dl.connectorId === "slack-alerts") return;
  await raiseAlert({
    key: `dead-letter:${dl.connectorId}:${dl.operation}`,
    severity: dl.status !== null && dl.status >= 400 && dl.status < 500 && dl.status !== 429 ? "warning" : "critical",
    source: dl.connectorId,
    title: `${dl.connectorId} ${dl.operation} failed and is waiting in dead letters`,
    detail: `${dl.error} (${dl.attempts} tries). Dead letter ${dl.id}.`,
    runbook: "dead-letter"
  });
});
