// Scheduled jobs (reliability ops). On Vercel, vercel.json cron calls /api/cron/daily once a day and
// /api/cron/dispatch for reminders; admins can also run them from Integration Hub → Reliability.
// Each step is independent: one failing step is recorded and the others still run.

import { getStore } from "../store.js";
import { newId, type CallRecord, type DeadLetter } from "../framework/connector.js";
import { raiseAlert } from "./alerts.js";
import { reconcile, type Payment } from "./payments.js";
import { dispatchDue, scheduleReminders, type Message } from "./comms.js";
import type { Lead } from "./leads.js";
import { getRetention, runRetention } from "./compliance.js";

export type JobRun = { id: string; at: string; job: "daily" | "dispatch"; trigger: string; ok: boolean; durationMs: number; steps: Array<{ name: string; ok: boolean; summary: string }> };
const RUNS = "jobRuns";

async function step(steps: JobRun["steps"], name: string, fn: () => Promise<string>) {
  try { steps.push({ name, ok: true, summary: await fn() }); }
  catch (e) { steps.push({ name, ok: false, summary: e instanceof Error ? e.message : "Failed" }); }
}

/** Reminders: schedule upcoming ones and send whatever is due. Safe to run every few minutes. */
export async function runDispatch(trigger: string): Promise<JobRun> {
  const started = Date.now();
  const steps: JobRun["steps"] = [];
  await step(steps, "Schedule reminders", async () => `${(await scheduleReminders()).created} new reminder(s) scheduled`);
  await step(steps, "Send due messages", async () => { const r = await dispatchDue(); return `${r.due} due: ${r.sent} sent, ${r.failed} failed`; });
  const run: JobRun = { id: newId("job"), at: new Date().toISOString(), job: "dispatch", trigger, ok: steps.every(s => s.ok), durationMs: Date.now() - started, steps };
  await getStore().docPut(RUNS, run);
  return run;
}

export async function runDaily(trigger: string): Promise<JobRun> {
  const store = getStore();
  const started = Date.now();
  const steps: JobRun["steps"] = [];
  const dayAgo = Date.now() - 86_400_000;

  await step(steps, "Payment reconciliation", async () => {
    const providers = [...new Set((await store.docList<Payment>("payments")).map(p => p.provider))];
    if (!providers.length) return "No payments yet";
    const out: string[] = [];
    for (const p of providers) {
      const r = await reconcile(p, trigger);
      out.push(r.error ? `${p}: ${r.error}` : `${p}: ${r.counts.matched} matched, ${r.counts.amount_mismatch + r.counts.missing_in_settlement + r.counts.unknown_settlement} to check, ${r.counts.pending_settlement} pending`);
    }
    return out.join(" · ");
  });

  await step(steps, "Reminders", async () => {
    const s = await scheduleReminders(); const d = await dispatchDue();
    return `${s.created} scheduled, ${d.sent} sent, ${d.failed} failed`;
  });

  await step(steps, "Message failures", async () => {
    const failed = (await store.docList<Message>("messages", { status: "failed" })).filter(m => Date.parse(m.createdAt) > dayAgo);
    if (failed.length) await raiseAlert({ key: "message-failures", severity: "warning", source: "communication", runbook: "message-failures", title: `${failed.length} patient message(s) failed in the last day`, detail: `Templates: ${[...new Set(failed.map(m => m.template))].join(", ")}.` });
    return `${failed.length} failed in the last 24 h`;
  });

  await step(steps, "Stale leads", async () => {
    const stale = (await store.docList<Lead>("leads", { status: "new" })).filter(l => Date.parse(l.receivedAt) < dayAgo);
    if (stale.length) await raiseAlert({ key: "stale-leads", severity: "info", source: "crm", runbook: "stale-leads", title: `${stale.length} lead(s) not contacted for over 24 hours`, detail: `Sources: ${[...new Set(stale.map(l => l.source))].join(", ")}.` });
    return `${stale.length} lead(s) waiting > 24 h`;
  });

  await step(steps, "Bookings without a report", async () => {
    const twoDays = Date.now() - 2 * 86_400_000;
    const late = (await store.listAppointments()).filter(a => a.status !== "cancelled" && !a.reportUrl && Date.parse(a.createdAt) < twoDays);
    if (late.length) await raiseAlert({ key: "missing-report", severity: "warning", source: "flabs-crm", runbook: "missing-report", title: `${late.length} booking(s) older than 48 h have no report`, detail: `Oldest: ${late.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0].integratorID}.` });
    return `${late.length} booking(s) without a report after 48 h`;
  });

  await step(steps, "Connector failure rates", async () => {
    const hourAgo = Date.now() - 3_600_000;
    const calls = (await store.docList<CallRecord>("connectorCalls")).filter(c => Date.parse(c.at) > hourAgo && !c.fromCache);
    const by = new Map<string, { total: number; failed: number }>();
    for (const c of calls) { const s = by.get(c.connectorId) ?? { total: 0, failed: 0 }; s.total++; if (!c.ok) s.failed++; by.set(c.connectorId, s); }
    const bad = [...by.entries()].filter(([, s]) => s.total >= 5 && s.failed / s.total > 0.2);
    for (const [id, s] of bad) await raiseAlert({ key: `failure-rate:${id}`, severity: "critical", source: id, runbook: "failure-rate", title: `${id}: ${Math.round((s.failed / s.total) * 100)} % of calls failed in the last hour`, detail: `${s.failed} of ${s.total} calls failed.` });
    return by.size ? `${by.size} connector(s) checked, ${bad.length} above 20 % failures` : "No partner calls in the last hour";
  });

  await step(steps, "Open dead letters", async () => {
    const open = (await store.docList<DeadLetter>("connectorDeadLetters", { resolved: false })).length;
    return `${open} waiting for replay`;
  });

  await step(steps, "Data retention", async () => {
    const { autoApply } = await getRetention();
    const r = await runRetention(autoApply);
    const total = r.results.reduce((n, x) => n + (autoApply ? x.deleted : x.expired), 0);
    return autoApply ? `${total} expired record(s) deleted` : `${total} record(s) past retention (dry run; auto-delete is off)`;
  });

  const run: JobRun = { id: newId("job"), at: new Date().toISOString(), job: "daily", trigger, ok: steps.every(s => s.ok), durationMs: Date.now() - started, steps };
  await store.docPut(RUNS, run);
  return run;
}

export const listJobRuns = async () => (await getStore().docList<JobRun>(RUNS)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 60);
