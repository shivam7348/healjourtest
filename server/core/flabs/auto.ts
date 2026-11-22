// Automatic Flabs work, so staff do not have to press buttons:
//   1. ensureCatalogSynced(): keeps each account's test/package mapping fresh (synced when older than 30 min).
//   2. autoPrebook(): after a Healjour booking reaches a lab account, also creates the Flabs pre-booking,
//      when the account's Pre-booking setup has "Auto pre-booking" switched on.

import { getStore } from "../store.js";
import { logIntegration } from "../logs.js";
import { recordAudit } from "../identity.js";
import { PARTY_REQUIRED_HINT, type FlabsConfig } from "./client.js";
import { syncFlabsCatalog } from "./sink.js";
import { checkAgainstSettings, emptyPrebookingSettings, preBookingSchema, sendPreBooking } from "./prebooking.js";

const SYNC_MAX_AGE_MS = 30 * 60 * 1000;
const RETRY_AFTER_ERROR_MS = 5 * 60 * 1000;
// An account whose test list needs a corporate will not start working by itself: check again only every 6 h.
const RETRY_AFTER_PARTY_REQUIRED_MS = 6 * 60 * 60 * 1000;

type SyncState = { lastSyncedAt?: string; lastError?: string; failedAt?: number; retryAfterMs?: number };
const syncState = new Map<string, SyncState>();
const inFlight = new Map<string, Promise<SyncState>>();

export type SyncStatus = { lastSyncedAt: string | null; error: string | null; ranNow: boolean };

/**
 * Syncs the account's catalog mapping when it is missing or older than 30 minutes.
 * Never throws: a Flabs outage leaves the old mapping in place and is reported in `error`.
 */
export async function ensureCatalogSynced(config: FlabsConfig, options: { force?: boolean } = {}): Promise<SyncStatus> {
  if (!config.branchId) return { lastSyncedAt: null, error: "This account has no branch set.", ranNow: false };
  const state = syncState.get(config.id) ?? {};

  // The newest syncedAt in the store survives restarts, so a fresh server does not re-sync needlessly.
  if (!state.lastSyncedAt) {
    const mappings = await getStore().listFlabsMappings(config.id);
    const newest = mappings.map(m => m.syncedAt).filter(Boolean).sort().at(-1);
    if (newest) state.lastSyncedAt = newest;
  }
  const age = state.lastSyncedAt ? Date.now() - Date.parse(state.lastSyncedAt) : Infinity;
  const recentlyFailed = state.failedAt !== undefined && Date.now() - state.failedAt < (state.retryAfterMs ?? RETRY_AFTER_ERROR_MS);
  if (!options.force && (age < SYNC_MAX_AGE_MS || recentlyFailed)) {
    syncState.set(config.id, state);
    return { lastSyncedAt: state.lastSyncedAt ?? null, error: recentlyFailed ? state.lastError ?? null : null, ranNow: false };
  }

  let running = inFlight.get(config.id);
  if (!running) {
    running = (async () => {
      try {
        const report = await syncFlabsCatalog(config);
        const next: SyncState = { lastSyncedAt: new Date().toISOString() };
        await logIntegration({
          type: "sync", status: "success", account: config.label, title: "Tests auto-synced",
          message: `${report.matched.length} test(s) and ${report.packages.matched.length} package(s) matched with Flabs.${report.created.length ? ` ${report.created.length} new test(s) added to the catalog.` : ""}`,
          ...(report.created.length ? { details: [`New: ${report.created.map(c => `${c.code} (${c.category})`).join(", ")}`.slice(0, 4000)] } : {})
        });
        return next;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Flabs sync failed.";
        await logIntegration({ type: "sync", status: "error", account: config.label, title: "Auto-sync failed", message });
        const partyRequired = message === PARTY_REQUIRED_HINT;
        return { ...state, lastError: message, failedAt: Date.now(), retryAfterMs: partyRequired ? RETRY_AFTER_PARTY_REQUIRED_MS : RETRY_AFTER_ERROR_MS };
      } finally {
        inFlight.delete(config.id);
      }
    })();
    inFlight.set(config.id, running);
  }
  const done = await running;
  syncState.set(config.id, done);
  return { lastSyncedAt: done.lastSyncedAt ?? null, error: done.failedAt !== undefined ? done.lastError ?? null : null, ranNow: true };
}

/** Starts a background sync for every account. Used at startup; never blocks the request. */
export function syncAllInBackground(configs: FlabsConfig[]) {
  for (const config of configs) void ensureCatalogSynced(config).catch(() => undefined);
}

export type AutoPrebookInput = {
  integratorId: string;
  first_name: string;
  last_name?: string;
  gender?: "male" | "female" | "other";
  age: number;
  age_type: "year" | "month" | "day";
  tests: Array<{ code: string }>;
  packages: Array<{ code: string }>;
  unmappedTests: string[];
  unmappedPackages: string[];
  /** Flabs IDs from the booking; used only if they are in the account's mapped doctor/hospital lists. */
  doctor?: string;
  hospital?: string;
};

export type AutoPrebookOutcome =
  | { status: "off" }
  | { status: "sent"; preBookingID?: string; integratorId: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

/** Creates the Flabs pre-booking for a booking that just went to a lab account. Never throws. */
export async function autoPrebook(config: FlabsConfig, booking: AutoPrebookInput): Promise<AutoPrebookOutcome> {
  if (config.party) return { status: "off" }; // pre-bookings go to the lab account only
  const settings = (await getStore().getPrebookingSettings(config.id)) ?? emptyPrebookingSettings(config.id);
  if (!settings.autoPrebooking) return { status: "off" };

  const skip = async (reason: string): Promise<AutoPrebookOutcome> => {
    await logIntegration({
      type: "booking", status: "info", account: config.label, title: "Auto pre-booking skipped",
      message: reason, integratorID: booking.integratorId
    });
    return { status: "skipped", reason };
  };
  if (!booking.gender) return skip("Gender is missing; Flabs needs it for a pre-booking.");
  if (!settings.defaultLeadSource) return skip("No default lead source in Pre-booking setup.");

  const parsed = preBookingSchema.safeParse({
    connectionId: config.id,
    integrator_id: `${booking.integratorId}-PB`.slice(0, 120),
    lead_source: settings.defaultLeadSource,
    rate_list_type: settings.defaultRateListType,
    first_name: booking.first_name,
    last_name: booking.last_name,
    gender: booking.gender,
    age: Math.floor(booking.age),
    age_type: booking.age_type,
    doctor: booking.doctor && settings.doctors.some(d => d.flabsId === booking.doctor) ? booking.doctor : undefined,
    hospital: booking.hospital && settings.hospitals.some(h => h.flabsId === booking.hospital) ? booking.hospital : undefined,
    tests: booking.tests,
    packages: booking.packages,
    unmappedTests: booking.unmappedTests,
    unmappedPackages: booking.unmappedPackages
  });
  if (!parsed.success) return skip(parsed.error.issues.map(i => i.message).join(" "));
  const settingErrors = checkAgainstSettings(parsed.data, settings);
  if (settingErrors.length) return skip(settingErrors.join(" "));

  await ensureCatalogSynced(config);
  try {
    const result = await sendPreBooking(config, parsed.data);
    await logIntegration({
      type: "booking", status: "success", account: config.label, title: "Auto pre-booking created in Flabs",
      message: result.preBookingID ? `Flabs returned pre-booking ID ${result.preBookingID}.` : "Flabs accepted the pre-booking.",
      integratorID: result.integratorId, leadId: result.preBookingID,
      details: [
        `From booking ${booking.integratorId}`,
        `Lead source: ${parsed.data.lead_source}${parsed.data.rate_list_type ? `, rate list ${parsed.data.rate_list_type}` : ""}`,
        `Mapped tests (sent by Flabs ID): ${result.mappedTests.join(", ") || "none"}`,
        `Unmapped tests (sent by name): ${result.unmappedTests.join(", ") || "none"}`
      ]
    });
    await recordAudit({
      actor: "auto_prebooking", action: "flabs.prebooking.sent",
      detail: `${config.label}: auto pre-booking ${result.integratorId}${result.preBookingID ? ` (${result.preBookingID})` : ""} from booking ${booking.integratorId}.`
    });
    return { status: "sent", preBookingID: result.preBookingID, integratorId: result.integratorId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Flabs rejected the pre-booking.";
    await logIntegration({
      type: "booking", status: "error", account: config.label, title: "Auto pre-booking not sent",
      message, integratorID: `${booking.integratorId}-PB`
    });
    return { status: "failed", error: message };
  }
}

/** One line for the booking response and logs. */
export function describeAutoPrebook(outcome: AutoPrebookOutcome): string | undefined {
  switch (outcome.status) {
    case "sent": return `Pre-booking created automatically${outcome.preBookingID ? ` (${outcome.preBookingID})` : ""}.`;
    case "skipped": return `Auto pre-booking skipped: ${outcome.reason}`;
    case "failed": return `Auto pre-booking failed: ${outcome.error}`;
    default: return undefined;
  }
}
