// Scheduled jobs: one list, each with an on/off switch, a daily time (IST) and "run now".
//
// Where they run   Vercel: vercel.json cron calls /api/cron/<job> at the same times (UTC).
//                  Anywhere else (local, plain Node server): an in-process timer checks every minute.
// Once a day       A per-job, per-day lock means the scheduled run happens once even if the cron and the
//                  timer both fire. "Run now" ignores the lock (it is a deliberate extra run).
// Switch           Off = scheduled runs are skipped; "Run now" still works.

import { getStore } from "../store.js";
import { runDaily, runDispatch, type JobRun } from "./jobs.js";
import { getHealthCheckSettings, runHealthCheck, saveHealthCheckSettings } from "./healthcheck.js";

export type JobId = "daily" | "dispatch" | "healthcheck";
type JobDef = { id: JobId; name: string; description: string; hourIst: number; minuteIst: number; cronUtc: string; run: (trigger: string) => Promise<JobRun | null> };

export const JOBS: JobDef[] = [
  { id: "daily", name: "Daily operations check", description: "Payment reconciliation, reminders, failed messages, stale leads, bookings without reports, connector failure rates, dead letters and data retention. Raises alerts.", hourIst: 6, minuteIst: 0, cronUtc: "30 0 * * *", run: runDaily },
  { id: "dispatch", name: "Patient reminders", description: "Schedules upcoming booking reminders and sends the messages that are due.", hourIst: 6, minuteIst: 30, cronUtc: "0 1 * * *", run: runDispatch },
  { id: "healthcheck", name: "Booking health check", description: "Test bookings to the destinations marked as test (set them in Daily health check); alerts if any fail.", hourIst: 10, minuteIst: 0, cronUtc: "30 4 * * *", run: t => runHealthCheck(t) }
];
export const isJobId = (id: string): id is JobId => JOBS.some(j => j.id === id);

type JobSettings = { id: "default"; enabled: Partial<Record<JobId, boolean>>; changed?: Partial<Record<JobId, { at: string; by: string }>> };
const SETTINGS = "jobSettings";
const LOCKS = "jobLocks";
const RUNS = "jobRuns";

const istNow = () => new Date(Date.now() + 5.5 * 3600_000);   // read with getUTC* for IST wall time
const istDay = () => istNow().toISOString().slice(0, 10);

async function settings(): Promise<JobSettings> {
  return (await getStore().docGet<JobSettings>(SETTINGS, "default")) ?? { id: "default", enabled: {} };
}
/** daily and dispatch are on unless switched off (they always ran before); the health check keeps its own switch. */
export async function isJobEnabled(id: JobId) {
  if (id === "healthcheck") return (await getHealthCheckSettings()).enabled;
  return (await settings()).enabled[id] ?? true;
}
export async function setJobEnabled(id: JobId, enabled: boolean, by: string) {
  if (id === "healthcheck") {
    const hc = await getHealthCheckSettings();
    await saveHealthCheckSettings({ ...hc, enabled, updatedAt: new Date().toISOString(), updatedBy: by });
  }
  const s = await settings();
  await getStore().docPut<JobSettings>(SETTINGS, { ...s, enabled: { ...s.enabled, [id]: enabled }, changed: { ...(s.changed ?? {}), [id]: { at: new Date().toISOString(), by } } });
}

/** The scheduled run: skipped when the job is off or already ran today (IST). */
export async function runScheduled(id: JobId, trigger: string): Promise<JobRun | { skipped: string }> {
  const job = JOBS.find(j => j.id === id)!;
  if (!(await isJobEnabled(id))) return { skipped: `${job.name} is switched off.` };
  const lockId = `${id}:${istDay()}`;
  const store = getStore();
  if (await store.docGet(LOCKS, lockId)) return { skipped: `${job.name} already ran today.` };
  await store.docPut(LOCKS, { id: lockId, at: new Date().toISOString(), trigger });
  return (await job.run(trigger)) ?? { skipped: "Nothing to do." };
}

export const runNow = (id: JobId, by: string) => JOBS.find(j => j.id === id)!.run(`manual by ${by}`);

function nextRunAt(job: JobDef, ranToday: boolean) {
  const now = istNow();
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), job.hourIst, job.minuteIst) - 5.5 * 3600_000);
  if (ranToday || at.getTime() <= Date.now()) at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString();
}

export async function jobOverview() {
  const store = getStore();
  const [s, runs] = await Promise.all([settings(), store.docList<JobRun>(RUNS)]);
  const today = istDay();
  return Promise.all(JOBS.map(async job => {
    const mine = runs.filter(r => r.job === job.id).sort((a, b) => b.at.localeCompare(a.at));
    const ranToday = Boolean(await store.docGet(LOCKS, `${job.id}:${today}`));
    const enabled = await isJobEnabled(job.id);
    return {
      id: job.id, name: job.name, description: job.description,
      schedule: `Daily ${String(job.hourIst).padStart(2, "0")}:${String(job.minuteIst).padStart(2, "0")} IST`, cronUtc: job.cronUtc,
      enabled, changed: s.changed?.[job.id] ?? null, ranToday,
      nextRunAt: enabled ? nextRunAt(job, ranToday) : null,
      lastRun: mine[0] ?? null, recentRuns: mine.slice(0, 10)
    };
  }));
}

const CATCH_UP_MINUTES = 120;
let timer: ReturnType<typeof setInterval> | undefined;
/** Where there is no platform cron (local or a plain Node server): every minute, start any job whose time has come. */
export function startScheduler() {
  if (timer || process.env.VERCEL) return;
  const tick = async () => {
    const now = istNow();
    const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    for (const job of JOBS) {
      // Run in the 2 hours after its time. A server that was off longer skips that day instead of
      // firing hours late (e.g. reminders at midnight).
      const due = job.hourIst * 60 + job.minuteIst;
      if (minutes < due || minutes > due + CATCH_UP_MINUTES) continue;
      await runScheduled(job.id, `scheduler (${String(job.hourIst).padStart(2, "0")}:${String(job.minuteIst).padStart(2, "0")} IST)`).catch(e => console.warn(`Job ${job.id} failed:`, e));
    }
  };
  timer = setInterval(() => { void tick(); }, 60_000);
  timer.unref?.();
}
