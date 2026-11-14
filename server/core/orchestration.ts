// Layer 04 - Orchestration
// Routing, retries and SLAs. Decides which modern sink each record belongs to,
// delivers with bounded exponential backoff, measures every delivery against the
// sink's SLA budget, and parks whatever still fails on a dead-letter queue.

import { createHash } from "node:crypto";
import type { CanonicalRecord, LayerIssue, LayerTrace } from "./types.js";
import { isoNow } from "./types.js";
import type { Delivery, DeliveryAttempt, PipelineRun } from "./models.js";
import type { IdentityDecision } from "./identity.js";
import { recordAudit, sinkPurpose } from "./identity.js";
import { toFhirBundle } from "./normalization.js";
import { deliverToFlabs } from "./flabs/sink.js";
import { logIntegration } from "./logs.js";
import { allFlabsConfigs, getFlabsConfig } from "./flabs/connection.js";
import type { FlabsConfig } from "./flabs/client.js";
import { getStore } from "./store.js";

export type { Delivery, DeliveryAttempt, PipelineRun } from "./models.js";

export type SinkDefinition = {
  id: string;
  label: string;
  category: "insurer" | "aggregator" | "corporate" | "platform";
  description: string;
  /** Accepts a record only when every predicate here holds. */
  accepts: { kinds: Array<CanonicalRecord["kind"]>; finalResultsOnly: boolean; testCodes?: string[] };
  slaMs: number;
  maxAttempts: number;
  backoffMs: number;
};

export const sinkCatalog: SinkDefinition[] = [
  {
    id: "insurer_underwriting", label: "Insurers - underwriting", category: "insurer",
    description: "Final, approved results used to price and underwrite a policy.",
    accepts: { kinds: ["result"], finalResultsOnly: true }, slaMs: 3000, maxAttempts: 4, backoffMs: 120
  },
  {
    id: "insurer_claims", label: "Insurers - claims", category: "insurer",
    description: "Result and order evidence attached to an in-flight claim.",
    accepts: { kinds: ["order", "result"], finalResultsOnly: false }, slaMs: 5000, maxAttempts: 4, backoffMs: 120
  },
  {
    id: "health_aggregator", label: "Health aggregators", category: "aggregator",
    description: "Marketplace platforms showing a member their own booked tests and reports.",
    accepts: { kinds: ["order", "result"], finalResultsOnly: false }, slaMs: 2000, maxAttempts: 3, backoffMs: 100
  },
  {
    // The only sink that talks to a real endpoint. Stays skipped until FLABS_* env vars are set.
    id: "flabs_crm", label: "Flabs CRM (lab bookings)", category: "platform",
    description: "Pushes lab orders into the Flabs CRM as leads or bookings.",
    accepts: { kinds: ["order"], finalResultsOnly: false }, slaMs: 8000, maxAttempts: 3, backoffMs: 200
  },
  {
    id: "corporate_wellness", label: "Corporates - wellness programs", category: "corporate",
    description: "Aggregated screening outcomes for an employer wellness program.",
    accepts: { kinds: ["result"], finalResultsOnly: true, testCodes: ["58410-2", "1558-6", "4548-4", "57698-3", "1989-3"] },
    slaMs: 8000, maxAttempts: 3, backoffMs: 150
  },
  {
    id: "healjour_record", label: "Healjour longitudinal record", category: "platform",
    description: "The patient's own record on Healjour. Always the first destination.",
    accepts: { kinds: ["order", "result"], finalResultsOnly: false }, slaMs: 1500, maxAttempts: 5, backoffMs: 80
  }
];

export const findSink = (id: string) => sinkCatalog.find(s => s.id === id);

export const listDeadLetters = () => getStore().listDeadLetters();
export const listRuns = (limit = 20) => getStore().listRuns(limit);

/** Takes the delivery off the queue atomically, so one click replays it once. */
export async function replayDeadLetter(deliveryId: string) {
  const delivery = await getStore().takeDeadLetter(deliveryId);
  if (!delivery) return undefined;
  const sink = findSink(delivery.sinkId);
  const attempt: DeliveryAttempt = {
    attempt: delivery.attempts.length + 1, at: isoNow(), outcome: "delivered",
    latencyMs: Math.round((sink?.slaMs ?? 2000) / 6),
    detail: "Manual replay from the dead-letter queue succeeded."
  };
  const replayed: Delivery = {
    ...delivery, status: "delivered", reason: undefined,
    attempts: [...delivery.attempts, attempt],
    totalLatencyMs: delivery.totalLatencyMs + attempt.latencyMs,
    slaMet: delivery.totalLatencyMs + attempt.latencyMs <= delivery.slaMs
  };
  await recordAudit({ actor: "orchestration_layer", action: "delivery.replayed", recordId: delivery.recordId, healjourId: delivery.healjourId, detail: `Replayed ${delivery.deliveryId} to ${delivery.sinkLabel}.` });
  return replayed;
}

/**
 * Deterministic stand-in for a real endpoint call: the same record and attempt always
 * produce the same outcome, so a run can be demonstrated and reasoned about. Nothing
 * leaves this process - no sink is actually contacted.
 */
function simulateCall(deliveryId: string, attempt: number, sink: SinkDefinition, failureMode: FailureMode) {
  const seed = parseInt(createHash("sha256").update(`${deliveryId}:${attempt}`).digest("hex").slice(0, 8), 16);
  const roll = (seed % 1000) / 1000;
  const latencyMs = Math.round(sink.slaMs * (0.12 + (seed % 73) / 73 * 0.55));
  if (failureMode === "permanent") return { ok: false, retryable: false, latencyMs, detail: "Sink rejected the payload (contract violation)." };
  if (failureMode === "transient") {
    const ok = attempt >= 3;
    return { ok, retryable: true, latencyMs, detail: ok ? "Accepted after the upstream recovered." : "Upstream returned 503; scheduling a retry." };
  }
  if (failureMode === "none") return { ok: true, retryable: true, latencyMs, detail: "Accepted." };
  // auto: mostly succeeds, occasionally needs a retry, rarely fails outright.
  if (roll < 0.74) return { ok: true, retryable: true, latencyMs, detail: "Accepted." };
  if (roll < 0.96) return { ok: false, retryable: true, latencyMs, detail: "Upstream returned 503; scheduling a retry." };
  return { ok: false, retryable: false, latencyMs, detail: "Sink rejected the payload (contract violation)." };
}

export type FailureMode = "auto" | "none" | "transient" | "permanent";

export type OrchestrationOptions = {
  runId: string;
  connectorId: string;
  requestedSinks: string[];
  failureMode: FailureMode;
  /** Which connected Flabs accounts to send to. Omit to send to all of them. */
  flabsConnectionIds?: string[];
};

type PlannedSink = { sink: SinkDefinition; flabs?: FlabsConfig; notConnected?: boolean };

/**
 * Expands the requested sinks once per run. Flabs becomes one destination per connected
 * account, so a lab, a corporate and a referral account each get their own delivery and retries.
 */
function planSinks(options: OrchestrationOptions, issues: LayerIssue[]): PlannedSink[] {
  const planned: PlannedSink[] = [];
  for (const sinkId of options.requestedSinks) {
    if (sinkId === "flabs_crm") {
      const configs = options.flabsConnectionIds?.length
        ? options.flabsConnectionIds.map(id => getFlabsConfig(id)).filter((c): c is FlabsConfig => Boolean(c))
        : allFlabsConfigs();
      const template = findSink("flabs_crm")!;
      if (!configs.length) planned.push({ sink: template, notConnected: true });
      for (const config of configs) {
        planned.push({ sink: { ...template, id: `flabs_crm:${config.id}`, label: `Flabs - ${config.label}` }, flabs: config });
      }
      continue;
    }
    const sink = findSink(sinkId);
    if (!sink) {
      issues.push({ layer: "orchestration", code: "unknown_sink", severity: "error", message: `No sink is registered as "${sinkId}".` });
      continue;
    }
    planned.push({ sink });
  }
  return planned;
}

function routingReason(record: CanonicalRecord, sink: SinkDefinition): string | undefined {
  if (!sink.accepts.kinds.includes(record.kind)) return `${sink.label} does not accept ${record.kind} records.`;
  if (sink.accepts.finalResultsOnly && !record.observations.some(o => o.status === "final" || o.status === "corrected")) {
    return `${sink.label} accepts final or corrected results only; this record has none.`;
  }
  if (sink.accepts.testCodes && !sink.accepts.testCodes.includes(record.order.code ?? "")) {
    return `${record.order.code ?? "this test"} is outside the panel ${sink.label} subscribes to.`;
  }
  return undefined;
}

export async function runOrchestration(
  input: Array<{ record: CanonicalRecord; decision: IdentityDecision }>,
  options: OrchestrationOptions
): Promise<LayerTrace<{ deliveries: Delivery[]; run: PipelineRun }>> {
  const started = Date.now();
  const store = getStore();
  const issues: LayerIssue[] = [];
  const deliveries: Delivery[] = [];
  const planned = planSinks(options, issues);

  for (const { record, decision } of input) {
    for (const { sink, flabs, notConnected } of planned) {
      const deliveryId = `${options.runId}-${record.recordId}-${sink.id}`.replace(/\s+/g, "");
      const base: Omit<Delivery, "status" | "attempts" | "totalLatencyMs" | "slaMet"> = {
        deliveryId, recordId: record.recordId, healjourId: decision.healjourId,
        sinkId: sink.id, sinkLabel: sink.label, slaMs: sink.slaMs,
        payloadPreview: JSON.stringify(toFhirBundle(record)).slice(0, 220)
      };

      const purpose = sinkPurpose[sink.id.split(":")[0]];
      if (purpose && !decision.consent.granted.includes(purpose)) {
        deliveries.push({ ...base, status: "skipped", reason: `Consent for ${purpose} is not in force.`, attempts: [], totalLatencyMs: 0, slaMet: true });
        continue;
      }
      const routingBlock = routingReason(record, sink);
      if (routingBlock) {
        deliveries.push({ ...base, status: "skipped", reason: routingBlock, attempts: [], totalLatencyMs: 0, slaMet: true });
        continue;
      }

      if (notConnected) {
        deliveries.push({ ...base, status: "skipped", reason: "No Flabs account is connected. Add one from the Test Catalog screen.", attempts: [], totalLatencyMs: 0, slaMet: true });
        continue;
      }

      const attempts: DeliveryAttempt[] = [];
      let totalLatencyMs = 0;
      let delivered = false;
      let lastDetail = "";

      for (let attempt = 1; attempt <= sink.maxAttempts; attempt++) {
        const call = flabs
          ? await deliverToFlabs(record, flabs)
          : simulateCall(deliveryId, attempt, sink, options.failureMode);
        // Backoff is doubled per attempt and counts against the SLA budget, exactly as it would in production.
        const backoff = attempt === 1 ? 0 : sink.backoffMs * 2 ** (attempt - 2);
        totalLatencyMs += call.latencyMs + backoff;
        lastDetail = call.detail;
        attempts.push({
          attempt, at: isoNow(),
          outcome: call.ok ? "delivered" : attempt === sink.maxAttempts || !call.retryable ? "failed" : "retrying",
          latencyMs: call.latencyMs + backoff, detail: call.detail
        });
        if (call.ok) { delivered = true; break; }
        if (!call.retryable) break;
      }

      const slaMet = delivered && totalLatencyMs <= sink.slaMs;
      if (delivered && !slaMet) {
        issues.push({ layer: "orchestration", code: "sla_breach", severity: "warning", recordId: record.recordId, message: `${sink.label} delivery took ${totalLatencyMs}ms against a ${sink.slaMs}ms budget.` });
      }
      if (!delivered) {
        issues.push({ layer: "orchestration", code: "dead_letter", severity: "error", recordId: record.recordId, message: `${sink.label} delivery failed after ${attempts.length} attempt(s): ${lastDetail}` });
      }

      const delivery: Delivery = {
        ...base, status: delivered ? "delivered" : "dead_letter",
        reason: delivered ? undefined : lastDetail, attempts, totalLatencyMs, slaMet
      };
      deliveries.push(delivery);
      if (!delivered) await store.addDeadLetter(delivery);
      if (flabs) {
        await logIntegration({
          type: "delivery", status: delivered ? (attempts.some(a => /409|already/i.test(a.detail)) ? "duplicate" : "success") : "error",
          account: flabs.label,
          title: delivered ? "Order sent to Flabs" : "Order not sent to Flabs (dead-letter)",
          message: lastDetail || (delivered ? "Accepted." : "Failed."),
          integratorID: record.recordId,
          details: [`Attempts: ${attempts.length}`, `Total time: ${totalLatencyMs}ms`]
        });
      }

      await recordAudit({
        actor: "orchestration_layer",
        action: delivered ? "delivery.succeeded" : "delivery.dead_lettered",
        recordId: record.recordId, healjourId: decision.healjourId,
        detail: `${sink.label}: ${attempts.length} attempt(s), ${totalLatencyMs}ms, SLA ${slaMet ? "met" : "missed"}.`
      });
    }
  }

  const run: PipelineRun = {
    runId: options.runId,
    startedAt: isoNow(),
    connectorId: options.connectorId,
    recordCount: input.length,
    delivered: deliveries.filter(d => d.status === "delivered").length,
    deadLettered: deliveries.filter(d => d.status === "dead_letter").length,
    skipped: deliveries.filter(d => d.status === "skipped").length,
    slaBreaches: deliveries.filter(d => d.status === "delivered" && !d.slaMet).length,
    durationMs: Date.now() - started
  };
  await store.addRun(run);

  const failedAll = deliveries.length > 0 && run.delivered === 0;
  return {
    layer: "orchestration",
    title: "Orchestration",
    status: failedAll ? "failed" : issues.length ? "passed_with_warnings" : "passed",
    durationMs: Date.now() - started,
    summary: `${run.delivered} delivered, ${run.skipped} skipped by routing or consent, ${run.deadLettered} dead-lettered, ${run.slaBreaches} SLA breach(es).`,
    issues,
    output: { deliveries, run }
  };
}
