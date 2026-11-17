// HTTP routes for the connector framework (admin only: they sit behind the global /api guard).

import type express from "express";
import { z } from "zod";
import { callConnector, connectorStats, getConnector, listCalls, listDeadLetters, newId, replayDeadLetter } from "./core/framework/connector.js";
import { mapEntity } from "./core/framework/mapping.js";
import { MAPPING_EXAMPLES, SAMPLE_BOOKING } from "./core/framework/registry.js";

const SCENARIOS = ["ok", "flaky", "ratelimited", "outage", "bad_request", "unauthorized"] as const;

/** A valid request body (and path values) for each operation, in that partner's own format. */
const SAMPLES: Record<string, { body?: unknown; params?: Record<string, string> }> = {
  "partner-sandbox.createOrder": { body: SAMPLE_BOOKING },
  "razorpay.createPaymentLink": { body: { amount: 120000, currency: "INR", description: "CBC + HbA1c", reference_id: "HJ-DEMO-0001", customer: { name: "Rahul Sharma", contact: "9876543210" }, notify: { sms: false, email: false } } },
  "razorpay.refund": { body: { amount: 20000, notes: { reason: "Test cancelled" } }, params: { paymentId: "pay_from_a_paid_link" } },
  "razorpay.settlements": { },
  "hdfc.createPaymentLink": { body: { amount: 120000, currency: "INR", description: "CBC + HbA1c", reference_id: "HJ-DEMO-0001" } },
  "hdfc.refund": { body: { amount: 20000 }, params: { paymentId: "pay_from_a_paid_link" } },
  "hdfc.settlements": { },
  "exotel.sendSms": { body: { From: "HEALJR", To: "9876543210", Body: "Your Healjour booking HJ-DEMO-0001 is confirmed." }, params: { sid: "sandbox" } },
  "exotel.connectCall": { body: { From: "9000000001", To: "9876543210", CallerId: "sandbox" }, params: { sid: "sandbox" } },
  "gmail.sendEmail": { body: { raw: Buffer.from("To: patient@example.com\r\nSubject: Booking confirmed\r\n\r\nYour booking HJ-DEMO-0001 is confirmed.").toString("base64url") } },
  "gcal.createEvent": { body: { summary: "Sample collection: Rahul Sharma", start: { dateTime: "2026-11-20T03:30:00.000Z" }, end: { dateTime: "2026-11-20T04:00:00.000Z" } } },
  "leadsquared.captureLead": { body: [{ Attribute: "FirstName", Value: "Rahul" }, { Attribute: "Phone", Value: "9876543210" }, { Attribute: "Source", Value: "website" }] },
  "meta-graph.getLead": { params: { leadgenId: "4422" } },
  "slack-alerts.post": { body: { text: "Test alert from the connector test bench" } }
  // app-webhooks is not offered here: events must be signed, so they are sent from Integration Hub → App Store.
};

const ruleSchema = z.object({
  to: z.string().min(1).max(200),
  from: z.string().max(200).optional(),
  const: z.unknown().optional(),
  default: z.unknown().optional(),
  required: z.boolean().optional(),
  transform: z.union([z.string().max(500), z.array(z.string().max(500)).max(10)]).optional()
});

export function registerFrameworkRoutes(app: express.Express) {
  app.get("/api/framework/connectors", async (_req, res) => {
    res.json({ connectors: await connectorStats(), scenarios: SCENARIOS, sample: SAMPLE_BOOKING, samples: SAMPLES, mappings: MAPPING_EXAMPLES });
  });

  // Test bench: run one operation. For the sandbox, "scenario" picks how the partner behaves.
  app.post("/api/framework/connectors/:id/call", async (req, res) => {
    const def = getConnector(req.params.id);
    if (!def) return res.status(404).json({ error: "Connector not found." });
    if (def.managedBy !== "framework") return res.status(400).json({ error: `${def.name} still uses its own client; it cannot be called from the test bench yet.` });
    const parsed = z.object({
      operation: z.string().min(1).max(60),
      version: z.string().max(20).optional(),
      body: z.unknown().optional(),
      scenario: z.enum(SCENARIOS).optional(),
      idempotencyKey: z.string().trim().max(120).optional(),
      params: z.record(z.string().max(200)).optional()
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map(i => i.message).join(" ") });
    const { operation, version, body, scenario, idempotencyKey, params } = parsed.data;
    const result = await callConnector(def.id, operation, {
      version, body, params, idempotencyKey: idempotencyKey || undefined,
      query: def.baseUrl.startsWith("mock://") ? { scenario: scenario ?? "ok" } : {},
      correlationId: newId("corr")
    });
    res.json(result);
  });

  app.get("/api/framework/calls", async (req, res) => {
    res.json({ calls: await listCalls(typeof req.query.connectorId === "string" ? req.query.connectorId : undefined) });
  });

  app.get("/api/framework/dead-letters", async (_req, res) => {
    res.json({ deadLetters: await listDeadLetters() });
  });

  app.post("/api/framework/dead-letters/:id/replay", async (req, res) => {
    const out = await replayDeadLetter(req.params.id);
    res.status(out.error ? 400 : 200).json(out);
  });

  // Mapping playground: try a spec against any input without calling a partner.
  app.post("/api/framework/map", (req, res) => {
    const parsed = z.object({ spec: z.object({ name: z.string().optional(), version: z.string().optional(), rules: z.array(ruleSchema).max(200) }), input: z.unknown() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(" ") });
    res.json(mapEntity(parsed.data.spec as Parameters<typeof mapEntity>[0], parsed.data.input));
  });
}
