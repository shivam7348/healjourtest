import express from "express";
import cors from "cors";
import { z } from "zod";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { connectorCatalog } from "./core/connectors.js";
import { listAudit, listPatients, setConsent, verifyAuditChain } from "./core/identity.js";
import { listDeadLetters, listRuns, replayDeadLetter, sinkCatalog } from "./core/orchestration.js";
import { coreTopology, runPipeline, samplePayloads } from "./core/pipeline.js";
import { connectStore, getStore } from "./core/store.js";
import type { PartnerLab, StudioIntegration } from "./core/models.js";
import { deleteWebhook, listPackages, listTests, listWebhooks, PARTY_REQUIRED_HINT, subscribeWebhook, testFlabsConnection } from "./core/flabs/client.js";
import { FLABS_EVENTS, handleFlabsEvent, type FlabsEvent } from "./core/flabs/webhooks.js";
import { syncFlabsCatalog } from "./core/flabs/sink.js";
import { autoPrebook, describeAutoPrebook, ensureCatalogSynced, syncAllInBackground } from "./core/flabs/auto.js";
import {
  allFlabsConfigs, deleteFlabsConnection, getFlabsConfig, listConnectionViews, loadFlabsConnections,
  saveFlabsConnection, setDefaultConnection, setWebhookToken, findByWebhookToken
} from "./core/flabs/connection.js";
import { canPersistSecret } from "./core/flabs/vault.js";
import { bookingSchema, sendBooking, FlabsError } from "./core/flabs/booking.js";
import { checkAgainstSettings, emptyPrebookingSettings, preBookingSchema, prebookingSettingsSchema, sendPreBooking } from "./core/flabs/prebooking.js";
import { listFolders, receiveResults, sendOrders, simulateLab } from "./core/studio-runner.js";
import { aiStatus, draftTests, suggestMatches } from "./core/test-builder.js";
import { registerPortalRoutes } from "./portal-routes.js";
import { can, currentUser } from "./core/portal/auth.js";
import { recordAudit } from "./core/identity.js";
import { logIntegration } from "./core/logs.js";
import { generateEncryptionKey, loadSettingsFile, setPublicBaseUrl, settingsStatus } from "./core/settings.js";

const storageInfo = () => {
  const store = getStore();
  return { kind: store.kind, detail: store.detail, durable: store.kind === "mongodb" };
};

const app = express();
app.use(cors());
// 5 MB: lab reports are uploaded as base64 JSON (files up to 3 MB).
app.use(express.json({ limit: "5mb" }));

// Sign-in and the Lab Portal check their own permissions. Everything else under /api is for Healjour admins only.
const OPEN_API = ["/api/health", "/api/auth/", "/api/portal/", "/api/webhooks/"];
app.use(async (req, res, next) => {
  if (!req.path.startsWith("/api/") || OPEN_API.some(p => req.path === p || req.path.startsWith(p))) return next();
  try {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ error: "Please sign in." });
    if (!can(user.role, "admin:all")) return res.status(403).json({ error: "This area is for Healjour admins." });
    req.portalUser = user;
    next();
  } catch (error) {
    next(error);
  }
});
registerPortalRoutes(app);

const configSchema = z.object({
  name: z.string().trim().min(3).max(100),
  labCode: z.string().regex(/^[A-Z0-9-]{3,40}$/),
  source: z.literal("healjour"),
  target: z.literal("lab"),
  protocol: z.literal("csv"),
  transport: z.enum(["sftp", "managed_gateway", "local_folder"]),
  delimiter: z.string().refine(v => [",", "|", ";", "\t"].includes(v), "Unsupported CSV delimiter"),
  pollingMinutes: z.number().int().refine(v => [1, 5, 15, 60].includes(v), "Polling must be 1, 5, 15, or 60 minutes"),
  direction: z.enum(["both", "outbound", "inbound"]),
  outboundPath: z.string().trim().max(240).optional(),
  inboundPath: z.string().trim().max(240).optional(),
  validationRules: z.object({
    requiredHeaders: z.boolean(),
    rejectUnknownTestCodes: z.boolean(),
    detectDuplicates: z.boolean(),
    validateDates: z.boolean(),
    requireApprovedResults: z.boolean(),
    quarantinePatientMismatch: z.boolean()
  })
});

function validatePaths(config: z.infer<typeof configSchema>) {
  const errors: string[] = [];
  const safePath = (p: string) => p.startsWith("/") && !p.split("/").includes("..") && !p.includes("\0");
  if (config.direction !== "inbound") {
    if (!config.outboundPath) errors.push("outboundPath is required for outbound or bidirectional flows.");
    else if (!safePath(config.outboundPath)) errors.push("outboundPath must be an absolute path without traversal segments.");
  }
  if (config.direction !== "outbound") {
    if (!config.inboundPath) errors.push("inboundPath is required for inbound or bidirectional flows.");
    else if (!safePath(config.inboundPath)) errors.push("inboundPath must be an absolute path without traversal segments.");
  }
  if (config.outboundPath && config.inboundPath && config.outboundPath === config.inboundPath) {
    errors.push("Inbound and outbound folders must be different.");
  }
  return errors;
}

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", mode: "demo", productionConnection: false, storage: storageInfo(), publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "") || null });
});

app.post("/api/integrations/validate", (req, res) => {
  const parsed = configSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      valid: false,
      errors: parsed.error.issues.map(issue => `${issue.path.join(".") || "config"}: ${issue.message}`)
    });
  }
  const pathErrors = validatePaths(parsed.data);
  if (pathErrors.length) return res.status(400).json({ valid: false, errors: pathErrors });

  return res.json({
    valid: true,
    status: "DRAFT_VALIDATED",
    integration: {
      name: parsed.data.name,
      labCode: parsed.data.labCode,
      protocol: parsed.data.protocol,
      direction: parsed.data.direction,
      pollingMinutes: parsed.data.pollingMinutes
    },
    warnings: [
      "Configuration validation does not verify a real SFTP host or credentials.",
      "This demo does not save the draft to a persistent database."
    ]
  });
});

app.post("/api/integrations/test", (req, res) => {
  const parsed = configSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      passed: false,
      message: "Configuration validation failed.",
      errors: parsed.error.issues.map(issue => `${issue.path.join(".") || "config"}: ${issue.message}`)
    });
  }
  const pathErrors = validatePaths(parsed.data);
  if (pathErrors.length) {
    return res.status(400).json({ passed: false, message: "Path validation failed.", errors: pathErrors });
  }

  // Deliberately a synthetic test only: no SFTP client is invoked and no partner is contacted.
  return res.json({
    passed: true,
    mode: "synthetic",
    message: "Configuration and synthetic fixture checks passed. No SFTP host was contacted; no production connection exists.",
    checks: [
      { name: "configuration_schema", status: "passed" },
      { name: "transport_settings_present", status: "passed" },
      { name: "direction_paths", status: "passed" },
      { name: "synthetic_mapping_fixture", status: "passed" },
      { name: "live_sftp_connectivity", status: "not_run" }
    ]
  });
});

// Saved Integration Studio connections. One per lab code: saving the same lab code again updates it.
app.get("/api/integrations", async (_req, res) => {
  res.json({ integrations: await getStore().listIntegrations() });
});

app.post("/api/integrations", async (req, res) => {
  const parsed = configSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, errors: parsed.error.issues.map(issue => `${issue.path.join(".") || "config"}: ${issue.message}`) });
  }
  const pathErrors = validatePaths(parsed.data);
  if (pathErrors.length) return res.status(400).json({ ok: false, errors: pathErrors });

  const store = getStore();
  const existing = (await store.listIntegrations()).find(i => i.labCode === parsed.data.labCode);
  const now = new Date().toISOString();
  const { source: _source, target: _target, protocol: _protocol, ...config } = parsed.data;
  const integration: StudioIntegration = {
    ...config,
    id: existing?.id ?? `int-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
    // Only keep the paths that this direction uses.
    outboundPath: config.direction !== "inbound" ? config.outboundPath : undefined,
    inboundPath: config.direction !== "outbound" ? config.inboundPath : undefined,
    status: "draft",
    lastTest: undefined,
    seenChecksums: existing?.seenChecksums,
    activity: existing?.activity,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  await store.saveIntegration(integration);
  await logIntegration({
    type: "account", status: "info", account: integration.name,
    title: existing ? "Integration updated" : "Integration saved",
    message: `${integration.labCode}: CSV, ${integration.direction === "both" ? "send and receive" : integration.direction === "outbound" ? "send orders only" : "receive results only"}, every ${integration.pollingMinutes} min. Draft, not deployed.`
  });
  res.status(existing ? 200 : 201).json({ ok: true, updated: Boolean(existing), integration });
});

app.post("/api/integrations/:id/test", async (req, res) => {
  const store = getStore();
  const integration = (await store.listIntegrations()).find(i => i.id === req.params.id);
  if (!integration) return res.status(404).json({ ok: false, error: "Integration not found." });
  const parsed = configSchema.safeParse({ ...integration, source: "healjour", target: "lab", protocol: "csv" });
  const errors = parsed.success ? validatePaths(parsed.data) : parsed.error.issues.map(i => i.message);
  const passed = errors.length === 0;
  // Synthetic only, like /api/integrations/test: no SFTP host is contacted.
  const message = passed ? "Configuration and synthetic fixture checks passed. No SFTP host was contacted." : errors.join(" ");
  const updated: StudioIntegration = { ...integration, status: passed ? "tested" : "draft", lastTest: { passed, message, at: new Date().toISOString() }, updatedAt: new Date().toISOString() };
  await store.saveIntegration(updated);
  res.json({ ok: true, passed, message, integration: updated });
});

// Sandbox run of a saved integration: send orders, let the simulated lab answer, receive results.
const findIntegration = async (id: string) => (await getStore().listIntegrations()).find(i => i.id === id);

app.get("/api/integrations/:id/files", async (req, res) => {
  const integration = await findIntegration(req.params.id);
  if (!integration) return res.status(404).json({ ok: false, error: "Integration not found." });
  res.json({ ok: true, ...listFolders(integration), activity: integration.activity ?? {} });
});

app.post("/api/integrations/:id/send", async (req, res) => {
  const integration = await findIntegration(req.params.id);
  if (!integration) return res.status(404).json({ ok: false, error: "Integration not found." });
  const count = Math.min(Math.max(Number(req.body?.count) || 5, 1), 50);
  try {
    const result = await sendOrders(integration, count);
    const at = new Date().toISOString();
    await getStore().saveIntegration({ ...integration, activity: { ...integration.activity, send: { at, file: result.file, orders: result.orders } }, updatedAt: at });
    await logIntegration({
      type: "delivery", status: "success", account: integration.name, title: "Orders file sent",
      message: `${result.orders} order(s) written to ${result.file} in the outbound folder (sandbox).`,
      details: result.rows.map(r => `${r.order_id}: ${r.first_name} ${r.last_name} (${r.patient_ref}), ${r.test_code}, ${r.priority}`)
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "Could not write the orders file." });
  }
});

app.post("/api/integrations/:id/simulate-lab", async (req, res) => {
  const integration = await findIntegration(req.params.id);
  if (!integration) return res.status(404).json({ ok: false, error: "Integration not found." });
  try {
    const result = simulateLab(integration);
    const at = new Date().toISOString();
    await getStore().saveIntegration({ ...integration, activity: { ...integration.activity, lab: { at, ...result } }, updatedAt: at });
    await logIntegration({
      type: "sync", status: result.results ? "success" : "info", account: integration.name, title: "Lab simulator ran",
      message: result.resultsFile
        ? `Picked up ${result.pickedUp.length} orders file(s) and wrote ${result.results} result(s) to ${result.resultsFile}.`
        : "No orders file was waiting in the outbound folder."
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "Lab simulator failed." });
  }
});

app.post("/api/integrations/:id/receive", async (req, res) => {
  const integration = await findIntegration(req.params.id);
  if (!integration) return res.status(404).json({ ok: false, error: "Integration not found." });
  try {
    const { outcomes, checksums } = await receiveResults(integration, integration.seenChecksums ?? []);
    const at = new Date().toISOString();
    const summary = {
      at, files: outcomes.length,
      imported: outcomes.filter(o => o.status.startsWith("imported")).length,
      rejected: outcomes.filter(o => o.status === "rejected").length,
      duplicates: outcomes.filter(o => o.status === "duplicate").length
    };
    await getStore().saveIntegration({ ...integration, seenChecksums: checksums, activity: { ...integration.activity, receive: summary }, updatedAt: at });
    for (const o of outcomes) {
      await logIntegration({
        type: "sync", status: o.status === "duplicate" ? "duplicate" : o.status === "rejected" ? "error" : "success",
        account: integration.name,
        title: o.status === "duplicate" ? "Results file skipped (duplicate)" : o.status === "rejected" ? "Results file rejected" : "Results file imported",
        message: o.reason ?? `${o.rows} row(s) through Healjour Core (run ${o.runId}); ${o.delivered ?? 0} delivered, ${o.quarantined ?? 0} held for review.`,
        details: [`File: ${o.file}`, ...(o.issues ?? [])]
      });
    }
    res.json({ ok: true, outcomes, summary });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "Could not read the inbound folder." });
  }
});

app.delete("/api/integrations/:id", async (req, res) => {
  const store = getStore();
  const integration = (await store.listIntegrations()).find(i => i.id === req.params.id);
  if (!integration) return res.status(404).json({ ok: false, error: "Integration not found." });
  await store.deleteIntegration(integration.id);
  await logIntegration({ type: "account", status: "info", account: integration.name, title: "Integration removed", message: `${integration.labCode} was removed.` });
  res.json({ ok: true });
});


// ---------------------------------------------------------------------------
// Healjour Core - the four layers between a legacy source and a modern sink.
// ---------------------------------------------------------------------------

app.get("/api/core/topology", (_req, res) => {
  res.json({ ...coreTopology, samples: Object.entries(samplePayloads).map(([id, s]) => ({ id, label: s.label, connectorId: s.connectorId })) });
});

app.get("/api/core/samples/:id", (req, res) => {
  const sample = samplePayloads[req.params.id];
  if (!sample) return res.status(404).json({ error: "Unknown sample payload." });
  res.json({ id: req.params.id, ...sample });
});

const pipelineSchema = z.object({
  connectorId: z.string().min(1).max(64),
  payload: z.string().min(1).max(500_000),
  delimiter: z.string().max(1).optional(),
  sinks: z.array(z.string().min(1).max(64)).min(1).max(sinkCatalog.length),
  flabsConnectionIds: z.array(z.string().min(1).max(64)).optional(),
  failureMode: z.enum(["auto", "none", "transient", "permanent"]).optional(),
  quarantineOnAmbiguity: z.boolean().optional(),
  normalization: z.object({
    rejectUnknownTestCodes: z.boolean(),
    validateDates: z.boolean(),
    requireApprovedResults: z.boolean()
  }).partial().optional()
});

app.post("/api/core/pipeline/run", async (req, res) => {
  const parsed = pipelineSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid pipeline request.", issues: parsed.error.issues.map(i => `${i.path.join(".") || "body"}: ${i.message}`) });
  }
  const unknownSinks = parsed.data.sinks.filter(id => !sinkCatalog.some(s => s.id === id));
  if (unknownSinks.length) return res.status(400).json({ error: `Unknown sink(s): ${unknownSinks.join(", ")}.` });
  res.json(await runPipeline(parsed.data));
});

app.get("/api/core/runs", async (_req, res) => {
  const [runs, deadLetters, audit, chain] = await Promise.all([listRuns(), listDeadLetters(), listAudit(), verifyAuditChain()]);
  res.json({ runs, deadLetters, audit, chain, storage: storageInfo() });
});

app.post("/api/core/dead-letters/:id/replay", async (req, res) => {
  const replayed = await replayDeadLetter(req.params.id);
  if (!replayed) return res.status(404).json({ error: "No dead-lettered delivery with that id." });
  res.json({ delivery: replayed, message: `Replayed to ${replayed.sinkLabel}.` });
});

app.get("/api/core/patients", async (_req, res) => {
  res.json({ patients: await listPatients(), connectors: connectorCatalog, sinks: sinkCatalog, storage: storageInfo() });
});

app.post("/api/core/patients/:id/consent", async (req, res) => {
  const parsed = z.object({
    purpose: z.enum(["treatment", "underwriting", "claims", "marketplace", "wellness", "research"]),
    granted: z.boolean()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Provide a valid purpose and granted flag." });
  const patient = await setConsent(req.params.id, parsed.data.purpose, parsed.data.granted);
  if (!patient) return res.status(404).json({ error: "Patient not found in the master index." });
  res.json({ patient, message: `Consent for ${parsed.data.purpose} ${parsed.data.granted ? "granted" : "withdrawn"}.` });
});


// Partner access registry. Labs, verifiers and issued tokens are persisted through the
// store, so a restart keeps approvals, rotations and revocations. Secrets are never stored:
// only a salted scrypt verifier is kept, and the plain secret is returned once on create/rotate.
const allowedScopes = ["orders:read", "orders:write", "results:read", "results:write", "reports:read"] as const;
const scopeSchema = z.object({ scopes: z.array(z.enum(allowedScopes)).min(1).max(allowedScopes.length) });
const publicLab = (lab: PartnerLab) => ({
  id: lab.id, name: lab.name, labCode: lab.labCode, status: lab.status, requestedAt: lab.requestedAt,
  reviewedAt: lab.reviewedAt, credentialStatus: lab.credentialStatus, clientId: lab.clientId,
  scopes: lab.scopes, createdAt: lab.createdAt, rotatedAt: lab.rotatedAt, revokedAt: lab.revokedAt,
  version: lab.version, secretAvailable: false
});
function issueCredential(lab: PartnerLab, scopes: string[]) {
  const clientId = `hj_${lab.labCode.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${randomBytes(5).toString("hex")}`;
  const secret = `hjs_${randomBytes(32).toString("base64url")}`;
  // Demo hash only. Production should use a reviewed secret-verification design and persistent key management.
  const salt = randomBytes(16).toString("hex");
  lab.clientId = clientId;
  lab.secretHash = `${salt}:${scryptSync(secret, salt, 32).toString("hex")}`;
  lab.scopes = [...new Set(scopes)];
  lab.credentialStatus = "active";
  lab.createdAt = new Date().toISOString();
  lab.rotatedAt = undefined;
  lab.revokedAt = undefined;
  lab.version += 1;
  return { clientId, clientSecret: secret, scopes: lab.scopes, version: lab.version, secretShownOnce: true };
}

const tokenTtlSeconds = 900;

app.post("/oauth/token", async (req, res) => {
  const bodySchema = z.object({
    grant_type: z.literal("client_credentials"),
    client_id: z.string().min(1).max(160),
    client_secret: z.string().min(1).max(512),
    scope: z.string().optional()
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request", error_description: "Provide grant_type=client_credentials, client_id, and client_secret." });
  const lab = (await getStore().listLabs()).find(item => item.clientId === parsed.data.client_id);
  if (!lab || lab.status !== "approved" || lab.credentialStatus !== "active" || !lab.secretHash) {
    return res.status(401).json({ error: "invalid_client", error_description: "Client credentials are invalid, revoked, or not approved." });
  }
  const [salt, storedHex] = lab.secretHash.split(":");
  if (!salt || !storedHex) return res.status(401).json({ error: "invalid_client", error_description: "Client credentials are invalid." });
  const submitted = scryptSync(parsed.data.client_secret, salt, 32);
  const stored = Buffer.from(storedHex, "hex");
  if (submitted.length !== stored.length || !timingSafeEqual(submitted, stored)) {
    return res.status(401).json({ error: "invalid_client", error_description: "Client credentials are invalid." });
  }
  const requestedScopes = parsed.data.scope?.trim() ? [...new Set(parsed.data.scope.trim().split(/\s+/))] : lab.scopes;
  if (requestedScopes.some(scope => !allowedScopes.includes(scope as typeof allowedScopes[number]) || !lab.scopes.includes(scope))) {
    return res.status(400).json({ error: "invalid_scope", error_description: "Requested scope is not assigned to this lab." });
  }
  const accessToken = randomBytes(32).toString("base64url");
  await getStore().saveToken({
    tokenHash: createHash("sha256").update(accessToken).digest("hex"),
    labId: lab.id, scopes: requestedScopes, expiresAt: new Date(Date.now() + tokenTtlSeconds * 1000)
  });
  return res.json({ access_token: accessToken, token_type: "Bearer", expires_in: tokenTtlSeconds, scope: requestedScopes.join(" ") });
});

app.get("/api/partner-access/labs", async (_req, res) => {
  const labs = await getStore().listLabs();
  const store = getStore();
  res.json({
    mode: "demo", labs: labs.map(publicLab), allowedScopes, storage: storageInfo(),
    note: `Partner registry is stored in ${store.kind === "mongodb" ? "MongoDB" : "memory (resets on restart)"}. No authentication is enforced by this prototype.`
  });
});
app.post("/api/partner-access/labs/:id/decision", async (req, res) => {
  const store = getStore();
  const lab = await store.getLab(req.params.id);
  if (!lab) return res.status(404).json({ error: "Lab not found." });
  const decision = z.object({ decision: z.enum(["approved", "rejected"]) }).safeParse(req.body);
  if (!decision.success) return res.status(400).json({ error: "Decision must be approved or rejected." });
  if (decision.data.decision === "rejected" && lab.credentialStatus === "active") {
    return res.status(409).json({ error: "Revoke active credentials before rejecting lab access." });
  }
  lab.status = decision.data.decision;
  lab.reviewedAt = new Date().toISOString();
  await store.saveLab(lab);
  res.json({ lab: publicLab(lab), message: `Lab access ${lab.status}.` });
});
app.post("/api/partner-access/labs/:id/credentials", async (req, res) => {
  const store = getStore();
  const lab = await store.getLab(req.params.id);
  if (!lab) return res.status(404).json({ error: "Lab not found." });
  if (lab.status !== "approved") return res.status(403).json({ error: "Healjour must approve this lab before credentials can be generated." });
  if (lab.credentialStatus === "active") return res.status(409).json({ error: "Active credentials already exist. Use rotation to replace them." });
  const parsed = scopeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Select at least one valid permission." });
  const issued = issueCredential(lab, parsed.data.scopes);
  await store.saveLab(lab);
  res.status(201).json({ lab: publicLab(lab), issued, warning: "Copy the client secret now. It cannot be retrieved again. Demo-only credentials; do not use for real patient data." });
});
app.post("/api/partner-access/labs/:id/rotate", async (req, res) => {
  const store = getStore();
  const lab = await store.getLab(req.params.id);
  if (!lab) return res.status(404).json({ error: "Lab not found." });
  if (lab.status !== "approved") return res.status(403).json({ error: "Only approved labs can rotate credentials." });
  if (lab.credentialStatus !== "active") return res.status(409).json({ error: "There are no active credentials to rotate. Generate credentials instead." });
  const parsed = scopeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Select at least one valid permission." });
  const originalCreatedAt = lab.createdAt;
  await store.deleteTokensForLab(lab.id);
  const issued = issueCredential(lab, parsed.data.scopes);
  lab.createdAt = originalCreatedAt;
  lab.rotatedAt = new Date().toISOString();
  await store.saveLab(lab);
  res.json({ lab: publicLab(lab), issued, warning: "The previous secret and its issued access tokens have been invalidated. Copy the new secret now; it cannot be retrieved again." });
});
app.post("/api/partner-access/labs/:id/revoke", async (req, res) => {
  const store = getStore();
  const lab = await store.getLab(req.params.id);
  if (!lab) return res.status(404).json({ error: "Lab not found." });
  if (lab.credentialStatus !== "active") return res.status(409).json({ error: "No active credentials to revoke." });
  await store.deleteTokensForLab(lab.id);
  lab.credentialStatus = "revoked";
  lab.secretHash = undefined;
  lab.revokedAt = new Date().toISOString();
  await store.saveLab(lab);
  res.json({ lab: publicLab(lab), message: "Credentials revoked." });
});

// Healjour's own test and package catalog. Other systems map onto these codes.
const catalogCode = z.string().trim().regex(/^[A-Z0-9-]{2,30}$/, "Use 2-30 uppercase letters, digits or hyphens.");
const catalogTestSchema = z.object({
  code: catalogCode,
  name: z.string().trim().min(2).max(120),
  loinc: z.string().trim().max(20).optional(),
  sampleType: z.string().trim().max(60).optional(),
  unit: z.string().trim().max(30).optional(),
  referenceRange: z.string().trim().max(120).optional(),
  price: z.number().min(0).max(1_000_000),
  active: z.boolean().default(true)
});
const catalogPackageSchema = z.object({
  code: catalogCode,
  name: z.string().trim().min(2).max(120),
  testCodes: z.array(catalogCode).min(1).max(100),
  price: z.number().min(0).max(1_000_000),
  active: z.boolean().default(true)
});

app.get("/api/catalog", async (_req, res) => {
  const store = getStore();
  const [tests, packages] = await Promise.all([store.listCatalogTests(), store.listCatalogPackages()]);
  res.json({ tests, packages, storage: storageInfo() });
});

app.post("/api/catalog/tests", async (req, res) => {
  const parsed = catalogTestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map(i => `${i.path.join(".") || "body"}: ${i.message}`).join(" ") });
  await getStore().saveCatalogTest({ ...parsed.data, updatedAt: new Date().toISOString() });
  res.json({ message: `Test ${parsed.data.code} saved.` });
});

app.post("/api/catalog/packages", async (req, res) => {
  const parsed = catalogPackageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map(i => `${i.path.join(".") || "body"}: ${i.message}`).join(" ") });
  const store = getStore();
  const known = new Set((await store.listCatalogTests()).map(t => t.code));
  const unknown = parsed.data.testCodes.filter(code => !known.has(code));
  if (unknown.length) return res.status(400).json({ error: `Unknown test code(s) in package: ${unknown.join(", ")}.` });
  await store.saveCatalogPackage({ ...parsed.data, updatedAt: new Date().toISOString() });
  res.json({ message: `Package ${parsed.data.code} saved.` });
});

// Test Builder: onboard many tests at once, then match them to a lab's Flabs tests (Claude when configured).
app.get("/api/builder/status", (_req, res) => res.json(aiStatus()));

app.post("/api/builder/draft", async (req, res) => {
  const parsed = z.object({ text: z.string().trim().min(2, "Write or paste at least one test.").max(20_000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Write or paste the tests." });
  const existing = (await getStore().listCatalogTests()).map(t => ({ code: t.code, name: t.name }));
  res.json(await draftTests(parsed.data.text, existing));
});

// Many tests in one go, plus an optional package made of them. Each row is checked on its own.
app.post("/api/catalog/tests/bulk", async (req, res) => {
  const parsed = z.object({
    tests: z.array(z.unknown()).min(1, "Add at least one test.").max(500),
    package: z.unknown().optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "No tests sent." });
  const store = getStore();
  const existing = new Set((await store.listCatalogTests()).map(t => t.code));
  const seen = new Set<string>();
  const created: string[] = [], updated: string[] = [], errors: Array<{ row: number; code?: string; error: string }> = [];
  for (const [i, raw] of parsed.data.tests.entries()) {
    const row = catalogTestSchema.safeParse(raw);
    if (!row.success) { errors.push({ row: i + 1, code: (raw as { code?: string })?.code, error: row.error.issues.map(x => `${x.path.join(".")}: ${x.message}`).join(" ") }); continue; }
    if (seen.has(row.data.code)) { errors.push({ row: i + 1, code: row.data.code, error: "Code used twice in this list." }); continue; }
    seen.add(row.data.code);
    await store.saveCatalogTest({ ...row.data, updatedAt: new Date().toISOString() });
    (existing.has(row.data.code) ? updated : created).push(row.data.code);
  }
  let packageMessage: string | undefined;
  if (parsed.data.package) {
    const pkg = catalogPackageSchema.safeParse(parsed.data.package);
    const known = new Set((await store.listCatalogTests()).map(t => t.code));
    if (!pkg.success) errors.push({ row: 0, error: `Package: ${pkg.error.issues.map(x => `${x.path.join(".")}: ${x.message}`).join(" ")}` });
    else if (pkg.data.testCodes.some(c => !known.has(c))) errors.push({ row: 0, code: pkg.data.code, error: "Package has tests that were not saved." });
    else { await store.saveCatalogPackage({ ...pkg.data, updatedAt: new Date().toISOString() }); packageMessage = `Package ${pkg.data.code} saved.`; }
  }
  await logIntegration({
    type: "sync", status: errors.length ? "info" : "success", account: "Test Builder", title: "Tests onboarded",
    message: `${created.length} created, ${updated.length} updated, ${errors.length} skipped.${packageMessage ? ` ${packageMessage}` : ""}`
  });
  res.json({ ok: true, created, updated, errors, packageMessage });
});

// Suggest a Flabs test for each Healjour test of this account that is not mapped yet. Nothing is saved here.
app.post("/api/flabs/connections/:id/ai-match", async (req, res) => {
  const config = getFlabsConfig(req.params.id);
  if (!config || !config.branchId) return res.status(404).json({ error: "Connection not found or has no branch." });
  const parsed = z.object({ codes: z.array(z.string()).max(500).optional(), includeMapped: z.boolean().optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: "Invalid request." });
  let flabs;
  try {
    flabs = await listTests(config, config.branchId);
  } catch (error) {
    return res.json({ available: false, suggestions: [], error: error instanceof Error ? error.message : "Flabs did not return its tests." });
  }
  const store = getStore();
  const [tests, mappings] = await Promise.all([store.listCatalogTests(), store.listFlabsMappings(config.id)]);
  const mapped = new Set(mappings.filter(m => m.kind === "test").map(m => m.healjourCode));
  const wanted = tests.filter(t => t.active
    && (!parsed.data.codes?.length || parsed.data.codes.includes(t.code))
    && (parsed.data.includeMapped || !mapped.has(t.code)));
  const result = await suggestMatches(wanted.map(t => ({ code: t.code, name: t.name })), flabs);
  res.json({ available: true, flabsCount: flabs.length, ...result });
});

// Flabs CRM accounts. Several can be connected at once: a lab, a corporate, a referral account.
// Secrets are accepted on write only and never returned; reads show a masked client ID.
const flabsPartySchema = z.object({
  field: z.enum(["corporateUser", "referredOrganization", "referredHospitalOrganization"]),
  id: z.string().trim().min(1).max(64)
});
const connectionSchema = z.object({
  label: z.string().trim().min(1).max(80),
  clientId: z.string().trim().min(3).max(160).optional(), // required on create; on edit the saved one is kept
  clientSecret: z.string().trim().min(3).max(512).optional(),
  baseUrl: z.string().trim().url().default("https://v2.flabs.in"),
  branchId: z.string().trim().min(1).max(64),
  phase: z.enum(["lead", "booking"]).default("booking"),
  party: flabsPartySchema.optional(),
  makeDefault: z.boolean().optional()
});

async function withMappingCounts() {
  return Promise.all(listConnectionViews().map(async view => ({
    ...view,
    webhookRegistered: Boolean(getFlabsConfig(view.id)?.webhookToken),
    mappedTests: (await getStore().listFlabsMappings(view.id)).length
  })));
}

app.get("/api/flabs/connections", async (_req, res) => {
  res.json({ connections: await withMappingCounts(), canPersistSecret: canPersistSecret() });
});

// Step 1 of the form: check the credentials and list their branches. Nothing is saved.
app.post("/api/flabs/test", async (req, res) => {
  const parsed = z.object({
    clientId: z.string().trim().min(3).max(160),
    clientSecret: z.string().trim().min(3).max(512),
    baseUrl: z.string().trim().url().default("https://v2.flabs.in")
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: "Enter both Client ID and Client Secret." });
  try {
    const branches = await testFlabsConnection({ ...parsed.data, baseUrl: parsed.data.baseUrl.replace(/\/$/, "") });
    res.json({ ok: true, branches });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "Could not connect to Flabs." });
  }
});

// Step 2: create or update an account. The login is re-checked so a bad account is never stored.
async function upsertConnection(id: string | undefined, body: unknown, res: express.Response) {
  const parsed = connectionSchema.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.issues.map(i => `${i.path.join(".") || "body"}: ${i.message}`).join(" ") });
  }
  const data = parsed.data;
  // Saving the same login + branch + party again updates that account instead of adding a duplicate card.
  if (!id && data.clientId) {
    const same = allFlabsConfigs().find(c =>
      c.clientId === data.clientId && (c.branchId ?? "") === data.branchId &&
      (c.party?.field ?? "") === (data.party?.field ?? "") && (c.party?.id ?? "") === (data.party?.id ?? ""));
    if (same) id = same.id;
  }
  const existing = id ? getFlabsConfig(id) : undefined;
  if (id && !existing) return res.status(404).json({ ok: false, error: "Connection not found." });
  const clientId = data.clientId ?? existing?.clientId;
  if (!clientId) return res.status(400).json({ ok: false, error: "Client ID is required." });
  const clientSecret = data.clientSecret ?? (existing && existing.clientId === clientId ? existing.clientSecret : undefined);
  if (!clientSecret) return res.status(400).json({ ok: false, error: "Client Secret is required." });
  try {
    await testFlabsConnection({ clientId, clientSecret, baseUrl: data.baseUrl.replace(/\/$/, "") });
    const view = await saveFlabsConnection({ ...data, id, clientId, clientSecret, baseUrl: data.baseUrl, makeDefault: data.makeDefault });
    const savedConfig = getFlabsConfig(view.id);
    const sync = savedConfig ? await ensureCatalogSynced(savedConfig, { force: true }) : null;
    await logIntegration({
      type: "account", status: "success", account: view.label,
      title: id ? "Account updated" : "New account connected",
      message: `Login check passed. Branch ${view.branchId}, ${view.phase}${view.party ? `, party ${view.party.field}` : ""}. Secret: ${view.secretStorage === "encrypted" ? "encrypted" : "in server memory only"}.`
    });
    const syncNote = sync?.error ? ` Tests could not be synced yet: ${sync.error}` : " Tests synced automatically.";
    res.json({
      ok: true, connection: view, sync,
      message: (view.secretStorage === "encrypted"
        ? `"${view.label}" saved (secret encrypted).`
        : `"${view.label}" is active. The secret is in server memory; it must be entered again after a restart (set FLABS_SECRET_KEY to save it permanently).`) + syncNote
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save.";
    await logIntegration({ type: "account", status: "error", account: data.label, title: "Account not saved", message });
    res.status(400).json({ ok: false, error: message });
  }
}

app.post("/api/flabs/connections", async (req, res) => upsertConnection(undefined, req.body, res));
app.put("/api/flabs/connections/:id", async (req, res) => upsertConnection(req.params.id, req.body, res));

app.delete("/api/flabs/connections/:id", async (req, res) => {
  const label = getFlabsConfig(req.params.id)?.label ?? req.params.id;
  const removed = await deleteFlabsConnection(req.params.id);
  if (!removed) return res.status(404).json({ ok: false, error: "Connection not found." });
  await logIntegration({ type: "account", status: "info", account: label, title: "Account removed", message: "Its orders will no longer be sent." });
  res.json({ ok: true, connections: await withMappingCounts() });
});

app.post("/api/flabs/connections/:id/default", async (req, res) => {
  const view = await setDefaultConnection(req.params.id);
  if (!view) return res.status(404).json({ ok: false, error: "Connection not found." });
  await logIntegration({ type: "account", status: "info", account: view.label, title: "Default account changed", message: "New orders without a chosen account will go to this account." });
  res.json({ ok: true, connections: await withMappingCounts() });
});

// Live call to Flabs "List Tests" for one account. Cost follows that account's party pricing.
app.get("/api/flabs/connections/:id/tests", async (req, res) => {
  const config = getFlabsConfig(req.params.id);
  if (!config) return res.status(404).json({ error: "Connection not found." });
  if (!config.branchId) return res.status(400).json({ error: "This account has no branch set." });
  try {
    const tests = await listTests(config, config.branchId);
    res.json({ branchId: config.branchId, party: config.party ?? null, count: tests.length, tests });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Flabs did not return tests." });
  }
});

app.post("/api/flabs/connections/:id/sync", async (req, res) => {
  const config = getFlabsConfig(req.params.id);
  if (!config) return res.status(404).json({ error: "Connection not found." });
  try {
    const report = await syncFlabsCatalog(config);
    await logIntegration({
      type: "sync", status: "success", account: config.label, title: "Tests synced",
      message: `${report.matched.length} test(s) and ${report.packages.matched.length} package(s) matched with Flabs.`,
      details: [
        `Matched tests: ${report.matched.map(m => `${m.healjourCode}→${m.flabsCode} ₹${m.flabsCost}`).join(", ") || "none"}`,
        `In Healjour, not in Flabs: ${report.healjourOnly.join(", ") || "none"}`,
        `In Flabs, not in Healjour: ${report.flabsOnly.join(", ") || "none"}`,
        `Matched packages: ${report.packages.matched.map(m => m.healjourCode).join(", ") || "none"}`
      ]
    });
    res.json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Flabs sync failed.";
    await logIntegration({ type: "sync", status: "error", account: config.label, title: "Sync failed", message });
    res.status(400).json({ error: message });
  }
});

// Manual booking form: what the form can offer for one Flabs account, and the send itself.
app.get("/api/flabs/booking-options", async (req, res) => {
  const connectionId = String(req.query.connectionId ?? "");
  const config = getFlabsConfig(connectionId);
  if (!config) return res.status(404).json({ error: "Connection not found." });
  const sync = await ensureCatalogSynced(config);
  const store = getStore();
  const [tests, packages, mappings] = await Promise.all([
    store.listCatalogTests(), store.listCatalogPackages(), store.listFlabsMappings(connectionId)
  ]);
  const testMap = new Map(mappings.filter(m => m.kind === "test").map(m => [m.healjourCode, m]));
  const packageMap = new Map(mappings.filter(m => m.kind === "package").map(m => [m.healjourCode, m]));
  res.json({
    connection: { id: config.id, label: config.label, branchId: config.branchId ?? null, phase: config.phase, party: config.party ?? null },
    sync,
    tests: tests.filter(t => t.active).map(t => ({ code: t.code, name: t.name, price: t.price, mapped: testMap.has(t.code), flabsCost: testMap.get(t.code)?.flabsCost ?? null, flabsId: testMap.get(t.code)?.flabsId ?? null, flabsName: testMap.get(t.code)?.flabsName ?? null })),
    packages: packages.filter(p => p.active).map(p => ({ code: p.code, name: p.name, price: p.price, testCodes: p.testCodes, mapped: packageMap.has(p.code), flabsId: packageMap.get(p.code)?.flabsId ?? null, flabsName: packageMap.get(p.code)?.flabsName ?? null }))
  });
});

app.post("/api/flabs/bookings", async (req, res) => {
  const parsed = bookingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.issues.map(i => `${i.path.join(".") || "form"}: ${i.message}`).join(" ") });
  }
  const config = getFlabsConfig(parsed.data.connectionId);
  if (!config) return res.status(404).json({ ok: false, error: "Flabs account not found. Connect it in Test Catalog." });
  try {
    const result = await sendBooking(config, parsed.data);
    // Every booking becomes a calendar entry: scheduled if it has a time, otherwise waiting to be scheduled.
    const nowIso = new Date().toISOString();
    await getStore().saveAppointment({
      id: `apt-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
      integratorID: result.integratorID, leadId: result.leadId, account: config.label,
      patientName: [parsed.data.first_name, parsed.data.last_name].filter(Boolean).join(" "),
      contact: parsed.data.contact,
      tests: [...result.mappedTests, ...result.unmappedTests],
      bookingType: parsed.data.bookingType, address: parsed.data.address,
      scheduledAt: parsed.data.scheduledAt, status: "unassigned", createdAt: nowIso, updatedAt: nowIso
    });
    await logIntegration({
      type: "booking", status: result.duplicate ? "duplicate" : "success", account: config.label,
      title: result.duplicate ? "Duplicate - already in Flabs" : `${result.phase === "booking" ? "Booking" : "Lead"} created in Flabs`,
      message: result.duplicate ? "Flabs returned 409: this patient already exists today, so no new entry was created." : `Flabs returned a ${result.phase} ID.`,
      integratorID: result.integratorID, leadId: result.leadId,
      details: [
        `Patient: ${parsed.data.first_name}${parsed.data.last_name ? " " + parsed.data.last_name : ""}, contact ${parsed.data.contact}`,
        `Mapped tests (sent by Flabs ID): ${result.mappedTests.join(", ") || "none"}`,
        `Unmapped tests (sent by name): ${result.unmappedTests.join(", ") || "none"}`,
        `Mapped packages: ${result.mappedPackages.join(", ") || "none"}`,
        `Unmapped packages (sent by name): ${result.unmappedPackages.join(", ") || "none"}`
      ]
    });
    await recordAudit({
      actor: "booking_form", action: result.duplicate ? "flabs.booking.duplicate" : "flabs.booking.sent",
      detail: `${config.label}: ${result.phase} ${result.integratorID}${result.leadId ? ` (lead ${result.leadId})` : ""}; ${result.mappedTests.length} mapped test(s), ${result.unmappedTests.length} unmapped.`
    });
    // Lab accounts with "Auto pre-booking" on also get the Flabs pre-booking, without a second form.
    const prebooking = result.duplicate ? { status: "off" as const } : await autoPrebook(config, {
      integratorId: result.integratorID,
      first_name: parsed.data.first_name, last_name: parsed.data.last_name,
      gender: parsed.data.gender, age: parsed.data.age, age_type: parsed.data.age_type,
      tests: parsed.data.tests, packages: parsed.data.packages,
      unmappedTests: parsed.data.unmappedTests.map(t => t.name),
      unmappedPackages: parsed.data.unmappedPackages.map(p => p.name),
      doctor: parsed.data.referredOrganization, hospital: parsed.data.referredHospitalOrganization
    });
    const prebookingNote = describeAutoPrebook(prebooking);
    res.json({
      ok: true, ...result, prebooking,
      message: (result.duplicate
        ? "This patient is already in Flabs today (409). No duplicate was created."
        : `${result.phase === "booking" ? "Booking" : "Lead"} created in Flabs.`) + (prebookingNote ? ` ${prebookingNote}` : "")
    });
  } catch (error) {
    const status = error instanceof FlabsError ? (error.status >= 400 && error.status < 500 ? 400 : 502) : 500;
    await logIntegration({
      type: "booking", status: "error", account: config.label, title: "Booking not sent",
      message: error instanceof Error ? error.message : "Flabs rejected the booking.",
      integratorID: parsed.data.integratorID ?? "(auto)", httpStatus: error instanceof FlabsError ? error.status : undefined,
      details: [`Patient: ${parsed.data.first_name}, contact ${parsed.data.contact}`]
    });
    res.status(status).json({ ok: false, error: error instanceof Error ? error.message : "Flabs rejected the booking." });
  }
});

// Pre-booking setup for one lab account: lead sources, rate lists, and doctor/hospital names mapped to Flabs IDs.
app.get("/api/flabs/connections/:id/prebooking-settings", async (req, res) => {
  const config = getFlabsConfig(req.params.id);
  if (!config) return res.status(404).json({ ok: false, error: "Connection not found." });
  res.json({ ok: true, settings: (await getStore().getPrebookingSettings(config.id)) ?? emptyPrebookingSettings(config.id) });
});

app.put("/api/flabs/connections/:id/prebooking-settings", async (req, res) => {
  const config = getFlabsConfig(req.params.id);
  if (!config) return res.status(404).json({ ok: false, error: "Connection not found." });
  const parsed = prebookingSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.issues.map(i => `${i.path.join(".") || "settings"}: ${i.message}`).join(" ") });
  }
  // Each doctor/hospital keeps a stable id; the same Flabs ID can appear only once per list.
  const withIds = (list: Array<{ name: string; flabsId: string }>) => {
    const seen = new Set<string>();
    return list.filter(r => !seen.has(r.flabsId) && seen.add(r.flabsId)).map(r => ({ id: `ref-${createHash("sha1").update(r.flabsId).digest("hex").slice(0, 10)}`, ...r }));
  };
  const settings = {
    connectionId: config.id,
    leadSources: parsed.data.leadSources,
    rateListTypes: parsed.data.rateListTypes,
    doctors: withIds(parsed.data.doctors),
    hospitals: withIds(parsed.data.hospitals),
    autoPrebooking: parsed.data.autoPrebooking,
    defaultLeadSource: parsed.data.defaultLeadSource,
    defaultRateListType: parsed.data.defaultRateListType,
    updatedAt: new Date().toISOString()
  };
  await getStore().savePrebookingSettings(settings);
  await logIntegration({
    type: "account", status: "info", account: config.label, title: "Pre-booking setup saved",
    message: `${settings.leadSources.length} lead source(s), ${settings.rateListTypes.length} rate list(s), ${settings.doctors.length} doctor(s), ${settings.hospitals.length} hospital(s) mapped. Auto pre-booking ${settings.autoPrebooking ? `on (lead source ${settings.defaultLeadSource})` : "off"}.`
  });
  res.json({ ok: true, settings });
});

// Pre-booking: starts Flabs' billing workflow and returns a preBookingID.
app.post("/api/flabs/prebookings", async (req, res) => {
  const parsed = preBookingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.issues.map(i => `${i.path.join(".") || "form"}: ${i.message}`).join(" ") });
  }
  const config = getFlabsConfig(parsed.data.connectionId);
  if (!config) return res.status(404).json({ ok: false, error: "Flabs account not found. Connect it in Test Catalog." });
  if (config.party) {
    return res.status(400).json({ ok: false, error: `Pre-bookings go to the lab account. "${config.label}" is a corporate or referral account; choose the lab account instead.` });
  }
  const settings = (await getStore().getPrebookingSettings(config.id)) ?? emptyPrebookingSettings(config.id);
  const settingErrors = checkAgainstSettings(parsed.data, settings);
  if (settingErrors.length) return res.status(400).json({ ok: false, error: settingErrors.join(" ") });
  const patientName = [parsed.data.first_name, parsed.data.last_name].filter(Boolean).join(" ");
  await ensureCatalogSynced(config);
  try {
    const result = await sendPreBooking(config, parsed.data);
    // The pre-booking shows on the calendar too; Flabs webhooks find it by integrator ID.
    const nowIso = new Date().toISOString();
    await getStore().saveAppointment({
      id: `apt-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
      integratorID: result.integratorId, leadId: result.preBookingID, account: config.label,
      patientName, contact: "",
      tests: [...result.mappedTests, ...result.unmappedTests, ...result.mappedPackages, ...result.unmappedPackages],
      bookingType: "Pre-booking", status: "unassigned", createdAt: nowIso, updatedAt: nowIso
    });
    await logIntegration({
      type: "booking", status: "success", account: config.label,
      title: "Pre-booking created in Flabs",
      message: result.preBookingID ? `Flabs returned pre-booking ID ${result.preBookingID}.` : "Flabs accepted the pre-booking.",
      integratorID: result.integratorId, leadId: result.preBookingID,
      details: [
        `Patient: ${patientName}, ${parsed.data.gender}, ${parsed.data.age} ${parsed.data.age_type}(s)`,
        `Lead source: ${parsed.data.lead_source}${parsed.data.barCode ? `, barcode ${parsed.data.barCode}` : ""}`,
        `Mapped tests (sent by Flabs ID): ${result.mappedTests.join(", ") || "none"}`,
        `Unmapped tests (sent by name): ${result.unmappedTests.join(", ") || "none"}`,
        `Mapped packages: ${result.mappedPackages.join(", ") || "none"}`,
        `Unmapped packages (sent by name): ${result.unmappedPackages.join(", ") || "none"}`
      ]
    });
    await recordAudit({
      actor: "prebooking_form", action: "flabs.prebooking.sent",
      detail: `${config.label}: pre-booking ${result.integratorId}${result.preBookingID ? ` (${result.preBookingID})` : ""}; ${result.mappedTests.length} mapped test(s), ${result.unmappedTests.length} unmapped.`
    });
    res.json({ ok: true, ...result, message: "Pre-booking created in Flabs." });
  } catch (error) {
    const status = error instanceof FlabsError ? (error.status >= 400 && error.status < 500 ? 400 : 502) : 500;
    await logIntegration({
      type: "booking", status: "error", account: config.label, title: "Pre-booking not sent",
      message: error instanceof Error ? error.message : "Flabs rejected the pre-booking.",
      integratorID: parsed.data.integrator_id ?? "(auto)", httpStatus: error instanceof FlabsError ? error.status : undefined,
      details: [`Patient: ${patientName}`]
    });
    res.status(status).json({ ok: false, error: error instanceof Error ? error.message : "Flabs rejected the pre-booking." });
  }
});

// Everything that happened with external systems, newest first, for the Logs screen.
app.get("/api/logs", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const logs = await getStore().listIntegrationLogs(limit);
  const count = (status: string) => logs.filter(l => l.status === status).length;
  res.json({
    logs,
    summary: { total: logs.length, success: count("success"), duplicate: count("duplicate"), error: count("error"), info: count("info") },
    storage: storageInfo()
  });
});

// Test mapping: Healjour catalog tests -> this account's Flabs test IDs.
const nameWords = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);

app.get("/api/flabs/connections/:id/mapping-view", async (req, res) => {
  const config = getFlabsConfig(req.params.id);
  if (!config) return res.status(404).json({ error: "Connection not found." });
  if (!config.branchId) return res.status(400).json({ error: "This account has no branch set." });
  try {
    const flabsTests = await listTests(config, config.branchId);
    const store = getStore();
    const [healjourTests, mappings] = await Promise.all([store.listCatalogTests(), store.listFlabsMappings(config.id)]);
    const testMappings = new Map(mappings.filter(m => m.kind === "test").map(m => [m.healjourCode, m]));
    const usedIds = new Set([...testMappings.values()].map(m => m.flabsId));
    res.json({
      branchId: config.branchId,
      party: config.party ?? null,
      healjourTests: healjourTests.map(t => {
        const m = testMappings.get(t.code);
        const wanted = new Set(nameWords(t.name));
        const suggestions = m ? [] : flabsTests
          .filter(f => !usedIds.has(f._id))
          .map(f => ({ f, score: (f.code && f.code.toUpperCase() === t.code.toUpperCase() ? 5 : 0) + nameWords(f.name).filter(w => wanted.has(w)).length }))
          .filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .map(x => ({ _id: x.f._id, name: x.f.name, code: x.f.code, cost: x.f.cost }));
        return {
          code: t.code, name: t.name, loinc: t.loinc ?? null, price: t.price,
          mapping: m ? { flabsId: m.flabsId, flabsCode: m.flabsCode, flabsName: m.flabsName, flabsCost: m.flabsCost, source: m.source ?? "auto" } : null,
          suggestions
        };
      }),
      flabsTests: flabsTests.map(f => ({ _id: f._id, name: f.name, code: f.code, cost: f.cost }))
    });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Flabs did not return tests." });
  }
});

// Flabs' own tests and packages for one account, for the "Map" dropdowns. Some accounts list them only
// with a corporate; then `available` is false and staff type the Flabs ID by hand.
app.get("/api/flabs/connections/:id/flabs-catalog", async (req, res) => {
  const config = getFlabsConfig(req.params.id);
  if (!config || !config.branchId) return res.status(404).json({ error: "Connection not found or has no branch." });
  try {
    const [tests, packages] = await Promise.all([listTests(config, config.branchId), listPackages(config, config.branchId)]);
    res.json({
      available: true,
      tests: tests.map(t => ({ _id: t._id, name: t.name, code: t.code, cost: t.cost })),
      packages: packages.map(p => ({ _id: p._id, name: p.name, code: p.code, cost: p.total }))
    });
  } catch (error) {
    res.json({ available: false, tests: [], packages: [], error: error instanceof Error ? error.message : "Flabs did not return its list." });
  }
});

// Staff choice: map a Healjour test or package to a Flabs one of this account. Kept across syncs.
// When Flabs lists them, the ID must be in the list; when it cannot (corporate-only list), the typed ID is saved as is.
app.put("/api/flabs/connections/:id/mappings/:kind/:code", async (req, res) => {
  const kind = req.params.kind;
  if (kind !== "test" && kind !== "package") return res.status(404).json({ error: "Unknown mapping kind." });
  const config = getFlabsConfig(req.params.id);
  if (!config || !config.branchId) return res.status(404).json({ error: "Connection not found or has no branch." });
  const parsed = z.object({
    flabsId: z.string().trim().min(1, "Enter the Flabs ID.").max(64),
    flabsName: z.string().trim().max(160).optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? `Choose a Flabs ${kind}.` });
  const store = getStore();
  const item = kind === "test"
    ? (await store.listCatalogTests()).find(t => t.code === req.params.code)
    : (await store.listCatalogPackages()).find(p => p.code === req.params.code);
  if (!item) return res.status(404).json({ error: `Healjour ${kind} not found.` });

  let live: { _id: string; name: string; code: string; cost: number } | undefined;
  let listed = true;
  try {
    live = kind === "test"
      ? (await listTests(config, config.branchId)).find(t => t._id === parsed.data.flabsId)
      : (await listPackages(config, config.branchId)).map(p => ({ _id: p._id, name: p.name, code: p.code, cost: p.total })).find(p => p._id === parsed.data.flabsId);
  } catch (error) {
    if (!(error instanceof Error && error.message === PARTY_REQUIRED_HINT)) {
      return res.status(502).json({ error: error instanceof Error ? error.message : "Flabs did not return its list." });
    }
    listed = false; // corporate-only list: trust the ID staff typed
  }
  if (listed && !live) return res.status(400).json({ error: `That ${kind} is not in this account's Flabs list.` });

  const rest = (await store.listFlabsMappings(config.id)).filter(m => !(m.kind === kind && m.healjourCode === item.code));
  const flabsName = live?.name ?? parsed.data.flabsName ?? item.name;
  await store.replaceFlabsMappings(config.id, [...rest, {
    connectionId: config.id, kind, healjourCode: item.code,
    flabsId: live?._id ?? parsed.data.flabsId, flabsCode: live?.code ?? "", flabsName, flabsCost: live?.cost ?? 0,
    source: "manual", syncedAt: new Date().toISOString()
  }]);
  await logIntegration({
    type: "sync", status: "info", account: config.label, title: `${kind === "test" ? "Test" : "Package"} mapped`,
    message: `${item.code} → Flabs "${flabsName}" (${live?._id ?? parsed.data.flabsId})${listed ? "" : ", ID entered by hand"}.`
  });
  res.json({ ok: true, message: `${item.code} mapped to Flabs "${flabsName}".` });
});

app.delete("/api/flabs/connections/:id/mappings/:kind/:code", async (req, res) => {
  const kind = req.params.kind;
  if (kind !== "test" && kind !== "package") return res.status(404).json({ error: "Unknown mapping kind." });
  const config = getFlabsConfig(req.params.id);
  if (!config) return res.status(404).json({ error: "Connection not found." });
  const store = getStore();
  const rest = (await store.listFlabsMappings(config.id)).filter(m => !(m.kind === kind && m.healjourCode === req.params.code));
  await store.replaceFlabsMappings(config.id, rest);
  res.json({ ok: true, message: `${req.params.code} is no longer mapped.` });
});

// Calendar: medical staff and the appointments they can be assigned to.
app.get("/api/calendar", async (_req, res) => {
  const store = getStore();
  const [staff, appointments] = await Promise.all([store.listStaff(), store.listAppointments()]);
  res.json({ staff, appointments });
});

app.post("/api/staff", async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(2).max(80), role: z.string().trim().min(2).max(60) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Name and role are required." });
  const staff = { id: `stf-${randomBytes(4).toString("hex")}`, name: parsed.data.name, role: parsed.data.role, active: true };
  await getStore().saveStaff(staff);
  res.json({ ok: true, staff, message: `${staff.name} added.` });
});

app.delete("/api/staff/:id", async (req, res) => {
  const store = getStore();
  const staff = (await store.listStaff()).find(s => s.id === req.params.id);
  if (!staff) return res.status(404).json({ error: "Staff member not found." });
  await store.deleteStaff(staff.id);
  // Appointments they held go back to the unassigned queue.
  for (const apt of (await store.listAppointments()).filter(a => a.staffId === staff.id)) {
    await store.saveAppointment({ ...apt, staffId: undefined, status: "unassigned", updatedAt: new Date().toISOString() });
  }
  res.json({ ok: true, message: `${staff.name} removed.` });
});

app.put("/api/appointments/:id", async (req, res) => {
  const parsed = z.object({
    staffId: z.string().min(1).nullable().optional(),
    scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
    status: z.enum(["unassigned", "assigned", "done", "cancelled"]).optional()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid appointment update." });
  const store = getStore();
  const apt = (await store.listAppointments()).find(a => a.id === req.params.id);
  if (!apt) return res.status(404).json({ error: "Appointment not found." });
  if (parsed.data.staffId && !(await store.listStaff()).some(s => s.id === parsed.data.staffId)) {
    return res.status(400).json({ error: "That staff member does not exist." });
  }
  const staffId = parsed.data.staffId === undefined ? apt.staffId : parsed.data.staffId ?? undefined;
  const scheduledAt = parsed.data.scheduledAt === undefined ? apt.scheduledAt : parsed.data.scheduledAt ?? undefined;
  let status = parsed.data.status ?? apt.status;
  if (parsed.data.status === undefined && (status === "unassigned" || status === "assigned")) {
    status = staffId ? "assigned" : "unassigned";
  }
  await store.saveAppointment({ ...apt, staffId, scheduledAt, status, updatedAt: new Date().toISOString() });
  res.json({ ok: true, message: staffId ? "Assigned." : "Unassigned." });
});

// Inbound Flabs webhooks. The token in the URL identifies the account; Flabs has no signature scheme,
// so the token is the only check and it is random per account. Anything else gets a 404.
app.post("/api/webhooks/flabs/:token", async (req, res) => {
  const config = findByWebhookToken(req.params.token);
  if (!config) return res.status(404).json({ success: false, message: "Unknown webhook." });
  const event = req.body as FlabsEvent;
  if (!event || typeof event.eventType !== "string") {
    return res.status(400).json({ success: false, message: "Missing eventType." });
  }
  try {
    const outcome = await handleFlabsEvent(config.label, event);
    res.status(200).json({ success: true, outcome });
  } catch (error) {
    // Non-2xx makes Flabs retry (up to 3 times). Log and report so the failure is visible.
    console.warn("Webhook handling failed:", error instanceof Error ? error.message : error);
    res.status(500).json({ success: false, message: "Could not process the event." });
  }
});

// Subscribe this Healjour endpoint to the Flabs events for one account.
app.post("/api/flabs/connections/:id/webhooks", async (req, res) => {
  const config = getFlabsConfig(req.params.id);
  if (!config) return res.status(404).json({ ok: false, error: "Connection not found." });
  const base = (process.env.PUBLIC_BASE_URL ?? "").trim().replace(/\/$/, "");
  if (!base.startsWith("https://")) {
    return res.status(400).json({ ok: false, error: "Set PUBLIC_BASE_URL to this server's public https address (for example from a tunnel or your deployed host). Flabs cannot reach localhost." });
  }
  const labID = String(req.body?.labID ?? config.branchId ?? "").trim();
  if (!labID) return res.status(400).json({ ok: false, error: "Flabs lab ID is needed. Use the branch ID or the labID from Flabs." });
  try {
    const token = config.webhookToken ?? randomBytes(24).toString("base64url");
    if (!config.webhookToken) await setWebhookToken(config.id, token);
    const endpoint = `${base}/api/webhooks/flabs/${token}`;
    const result = await subscribeWebhook({ ...config, webhookToken: token }, { labID, events: [...FLABS_EVENTS], endpoint });
    await logIntegration({ type: "account", status: "success", account: config.label, title: "Webhooks registered", message: `Flabs will send ${FLABS_EVENTS.length} event types to Healjour.` });
    res.json({ ok: true, endpoint, message: result.message });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Flabs did not accept the webhook.";
    await logIntegration({ type: "account", status: "error", account: config.label, title: "Webhook registration failed", message });
    res.status(400).json({ ok: false, error: message });
  }
});

app.get("/api/flabs/connections/:id/webhooks", async (req, res) => {
  const config = getFlabsConfig(req.params.id);
  if (!config) return res.status(404).json({ ok: false, error: "Connection not found." });
  const labID = String(req.query.labID ?? config.branchId ?? "");
  try {
    res.json({ ok: true, webhooks: await listWebhooks(config, labID), endpointRegistered: Boolean(config.webhookToken) });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "Could not list webhooks." });
  }
});

app.delete("/api/flabs/connections/:id/webhooks/:webhookId", async (req, res) => {
  const config = getFlabsConfig(req.params.id);
  if (!config) return res.status(404).json({ ok: false, error: "Connection not found." });
  const labID = String(req.query.labID ?? config.branchId ?? "");
  try {
    const result = await deleteWebhook(config, labID, req.params.webhookId);
    res.json({ ok: true, message: result.message });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "Could not delete the webhook." });
  }
});

// Settings screen: encryption key and public address. The key itself is never returned.
app.get("/api/settings", (_req, res) => res.json(settingsStatus()));

app.post("/api/settings/encryption-key", (_req, res) => {
  let result: { created: boolean };
  try {
    result = generateEncryptionKey();
  } catch (error) {
    return res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "Could not create the key." });
  }
  if (!result.created) {
    return res.status(409).json({ ok: false, error: "An encryption key already exists. It is never replaced, because saved secrets depend on it." });
  }
  res.json({ ok: true, message: "Encryption key created. Accounts connected from now on are saved encrypted. Accounts connected before this must be connected again." });
});

app.post("/api/settings/public-base-url", (req, res) => {
  try {
    const url = setPublicBaseUrl(String(req.body?.url ?? ""));
    res.json({ ok: true, publicBaseUrl: url, message: "Public address saved." });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : "Could not save the address." });
  }
});

// Next.js serves the UI and routes /api/* here (src/pages/api/[...path].ts), locally and on Vercel.
// Startup work runs once per server instance, before the first request touches the store or registry.
let ready: Promise<void> | null = null;

export function ensureReady(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      loadSettingsFile();
      await connectStore();
      await loadFlabsConnections();
      // Keep every account's test mapping fresh without anyone pressing "Sync".
      syncAllInBackground(allFlabsConfigs());
    })().catch(error => {
      ready = null; // let the next request try again instead of failing forever
      throw error;
    });
  }
  return ready;
}

export { app };
