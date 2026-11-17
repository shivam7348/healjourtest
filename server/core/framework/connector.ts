// Reusable connector framework.
// Every partner call (HIS/LIS, communication, CRM, payments, App Store) goes through callConnector(), which gives it:
//   - authentication (none, API key, bearer, basic, OAuth 2.0 client credentials with token caching)
//   - a per-connector rate limit (token bucket)
//   - retries with exponential backoff and jitter, honouring Retry-After
//   - idempotency (same key = same result, no second call; the key is also sent to the partner)
//   - versioned operations and field mappings (v1 and v2 of a partner API side by side)
//   - a structured call log, and a dead-letter queue with replay for calls that still fail
// A new integration is then mostly a ConnectorDefinition plus mapping specs, not new plumbing.

import { randomBytes } from "node:crypto";
import { getStore } from "../store.js";
import { mapEntity, type MappingSpec } from "./mapping.js";
import { mockTransport } from "./sandbox.js";
import { decrypt, encrypt } from "../compliance/crypto.js";

export type Family = "his_lis" | "communication" | "crm" | "payments" | "app_store" | "other";

export type AuthConfig =
  | { type: "none" }
  | { type: "api_key"; header: string; secretEnv: string; sandboxValue?: string }
  | { type: "bearer"; secretEnv: string; sandboxValue?: string }
  | { type: "basic"; userEnv: string; passEnv: string; sandboxUser?: string; sandboxPass?: string }
  | { type: "query_keys"; params: Array<{ name: string; env: string; sandboxValue?: string }> }
  | { type: "oauth2_client_credentials"; tokenUrl: string; clientIdEnv: string; clientSecretEnv: string; scope?: string };

export type RetryPolicy = { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; retryOn: number[] };
export type RateLimit = { requests: number; perMs: number };

export type Operation = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path per API version, e.g. { v1: "/v1/orders", v2: "/v2/orders" }. "@" = the base URL itself (incoming-webhook style URLs). */
  paths: Record<string, string>;
  /** How the body is sent. Most APIs take JSON; some (e.g. Exotel) take form fields. */
  bodyFormat?: "json" | "form";
  /** Request mapping per version (Healjour shape -> partner shape). */
  mapRequest?: Record<string, MappingSpec>;
  description?: string;
};

export type ConnectorDefinition = {
  id: string;
  name: string;
  family: Family;
  description: string;
  baseUrl: string;               // "mock://..." uses the in-process sandbox partner
  defaultVersion: string;
  versions: string[];
  auth: AuthConfig;
  retry: RetryPolicy;
  rateLimit: RateLimit;
  timeoutMs: number;
  operations: Record<string, Operation>;
  /** "framework" = calls go through callConnector(); "legacy" = listed here, still uses its own client. */
  managedBy: "framework" | "legacy";
};

export type Attempt = { n: number; at: string; status: number | null; ok: boolean; waitedMs: number; error?: string; durationMs: number };
export type CallResult = {
  callId: string; ok: boolean; status: number | null; data: unknown; attempts: Attempt[];
  fromCache: boolean; version: string; sentBody?: unknown; mappingErrors?: string[]; deadLetterId?: string; error?: string;
};
export type CallRecord = {
  id: string; at: string; connectorId: string; operation: string; version: string; method: string; path: string;
  ok: boolean; status: number | null; attempts: number; durationMs: number; fromCache: boolean;
  idempotencyKey?: string; correlationId: string; error?: string; replayOf?: string;
};
export type DeadLetter = {
  id: string; at: string; connectorId: string; operation: string; version: string;
  // The payload can hold patient data, so it is stored encrypted (see compliance/crypto.ts).
  request: { bodyEnc?: string; query?: Record<string, string>; params?: Record<string, string> }; idempotencyKey?: string; correlationId: string;
  status: number | null; error: string; attempts: number;
  replays: Array<{ at: string; ok: boolean; status: number | null; callId: string }>;
  resolved: boolean;
};

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 300, maxDelayMs: 5000, retryOn: [408, 425, 429, 500, 502, 503, 504] };

const CALLS = "connectorCalls";
const DEAD = "connectorDeadLetters";
const IDEMPOTENCY = "connectorIdempotency";
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

// Reliability ops subscribe here to raise an alert when a call ends in the dead-letter queue.
let deadLetterListener: ((dl: DeadLetter) => Promise<void>) | null = null;
export function onDeadLetter(fn: (dl: DeadLetter) => Promise<void>) { deadLetterListener = fn; }

const registry = new Map<string, ConnectorDefinition>();
export function registerConnector(def: ConnectorDefinition) { registry.set(def.id, def); }
export function listConnectors() { return [...registry.values()]; }
export function getConnector(id: string) { return registry.get(id); }

export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------- rate limit: one token bucket per connector ----------
const buckets = new Map<string, { tokens: number; updated: number }>();
async function takeToken(def: ConnectorDefinition): Promise<number> {
  const { requests, perMs } = def.rateLimit;
  const ratePerMs = requests / perMs;
  let waited = 0;
  for (;;) {
    const now = Date.now();
    const b = buckets.get(def.id) ?? { tokens: requests, updated: now };
    b.tokens = Math.min(requests, b.tokens + (now - b.updated) * ratePerMs);
    b.updated = now;
    if (b.tokens >= 1) { b.tokens -= 1; buckets.set(def.id, b); return waited; }
    buckets.set(def.id, b);
    const wait = Math.ceil((1 - b.tokens) / ratePerMs);
    waited += wait;
    await sleep(wait);
  }
}

// ---------- authentication ----------
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
class CredentialError extends Error {}
const secret = (name: string, fallback?: string) => {
  const v = process.env[name]?.trim() || fallback;
  if (!v) throw new CredentialError(`Missing credential: set ${name} on the server.`);
  return v;
};

/** Headers (and for some partners query values) that authenticate one request. */
async function authParts(def: ConnectorDefinition): Promise<{ headers: Record<string, string>; query: Record<string, string> }> {
  const a = def.auth;
  if (a.type === "query_keys") return { headers: {}, query: Object.fromEntries(a.params.map(p => [p.name, secret(p.env, p.sandboxValue)])) };
  return { headers: await authHeaders(def), query: {} };
}

async function authHeaders(def: ConnectorDefinition): Promise<Record<string, string>> {
  const a = def.auth;
  switch (a.type) {
    case "none": return {};
    case "query_keys": return {};
    case "api_key": return { [a.header]: secret(a.secretEnv, a.sandboxValue) };
    case "bearer": return { Authorization: `Bearer ${secret(a.secretEnv, a.sandboxValue)}` };
    case "basic": return { Authorization: `Basic ${Buffer.from(`${secret(a.userEnv, a.sandboxUser)}:${secret(a.passEnv, a.sandboxPass)}`).toString("base64")}` };
    case "oauth2_client_credentials": {
      const cached = tokenCache.get(def.id);
      if (cached && cached.expiresAt > Date.now() + 30_000) return { Authorization: `Bearer ${cached.token}` };
      const body = new URLSearchParams({ grant_type: "client_credentials", client_id: secret(a.clientIdEnv), client_secret: secret(a.clientSecretEnv) });
      if (a.scope) body.set("scope", a.scope);
      const res = await fetch(a.tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
      const data = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number };
      if (!res.ok || !data.access_token) throw new CredentialError(`Token request failed (HTTP ${res.status}).`);
      tokenCache.set(def.id, { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 });
      return { Authorization: `Bearer ${data.access_token}` };
    }
  }
}

// ---------- one HTTP attempt ----------
type Raw = { status: number; headers: Record<string, string>; data: unknown };
async function send(def: ConnectorDefinition, method: string, path: string, query: Record<string, string>, headers: Record<string, string>, body: unknown, attemptKey: string, format: "json" | "form" = "json"): Promise<Raw> {
  if (def.baseUrl.startsWith("mock://")) return mockTransport({ host: def.baseUrl.slice("mock://".length).split(/[/?]/)[0], method, path, query, headers, body, attemptKey });
  const url = path === "@" ? new URL(def.baseUrl) : new URL(path, def.baseUrl);
  Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), def.timeoutMs);
  const payload = body === undefined ? undefined
    : format === "form" ? new URLSearchParams(Object.entries(body as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")])).toString()
    : JSON.stringify(body);
  try {
    const res = await fetch(url, {
      method, signal: ac.signal,
      headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": format === "form" ? "application/x-www-form-urlencoded" : "application/json" } : {}), ...headers },
      body: payload
    });
    const text = await res.text();
    let data: unknown = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), data };
  } finally {
    clearTimeout(timer);
  }
}

function backoff(policy: RetryPolicy, attempt: number, retryAfter?: string) {
  const ra = retryAfter !== undefined ? Number(retryAfter) : NaN;
  if (Number.isFinite(ra) && ra >= 0) return Math.min(policy.maxDelayMs, ra * 1000);
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(exp * (0.5 + Math.random() * 0.5)); // jitter: 50–100 % of the exponential delay
}

export type CallOptions = {
  body?: unknown;
  query?: Record<string, string>;
  /** Values for "{name}" placeholders in the operation path, e.g. /v1/payments/{paymentId}/refund. */
  params?: Record<string, string>;
  /** Extra headers for this call (e.g. a webhook signature). */
  headers?: Record<string, string>;
  /** Send to this base URL instead of the connector's (App Store apps each have their own webhook URL). Caller validates it. */
  baseUrl?: string;
  version?: string;
  idempotencyKey?: string;
  correlationId?: string;
  replayOf?: string;
};

/** The one entry point for partner calls. Never throws: failures come back as ok=false and land in the dead-letter queue. */
export async function callConnector(connectorId: string, operationId: string, opts: CallOptions = {}): Promise<CallResult> {
  const store = getStore();
  const callId = newId("call");
  const correlationId = opts.correlationId ?? newId("corr");
  const def = registry.get(connectorId);
  const started = Date.now();
  const at = new Date().toISOString();
  const query = opts.query ?? {};

  const finish = async (r: Omit<CallResult, "callId">, method = "", path = ""): Promise<CallResult> => {
    const rec: CallRecord = {
      id: callId, at, connectorId, operation: operationId, version: r.version, method, path,
      ok: r.ok, status: r.status, attempts: r.attempts.length, durationMs: Date.now() - started, fromCache: r.fromCache,
      idempotencyKey: opts.idempotencyKey, correlationId, error: r.error, replayOf: opts.replayOf
    };
    await store.docPut(CALLS, rec);
    return { callId, ...r };
  };

  if (!def) return finish({ ok: false, status: null, data: null, attempts: [], fromCache: false, version: "", error: `Unknown connector ${connectorId}.` });
  const op = def.operations[operationId];
  const version = opts.version ?? def.defaultVersion;
  if (!op) return finish({ ok: false, status: null, data: null, attempts: [], fromCache: false, version, error: `Unknown operation ${operationId}.` });
  const template = op.paths[version];
  if (!template) return finish({ ok: false, status: null, data: null, attempts: [], fromCache: false, version, error: `Operation ${operationId} has no ${version} version.` }, op.method);
  const missingParam = [...template.matchAll(/\{(\w+)\}/g)].map(m => m[1]).find(name => !opts.params?.[name]);
  if (missingParam) return finish({ ok: false, status: null, data: null, attempts: [], fromCache: false, version, error: `Missing path value "${missingParam}".` }, op.method, template);
  const path = template.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(opts.params![name]));

  // Idempotency: a repeated key returns the stored result instead of calling the partner again.
  const idemId = opts.idempotencyKey ? `${connectorId}:${operationId}:${opts.idempotencyKey}` : "";
  if (idemId) {
    const hit = await store.docGet<{ id: string; at: string; result: CallResult }>(IDEMPOTENCY, idemId);
    if (hit && Date.now() - Date.parse(hit.at) < IDEMPOTENCY_TTL_MS) {
      const { callId: _firstCall, ...stored } = hit.result;
      return finish({ ...stored, fromCache: true, attempts: [] }, op.method, path);
    }
  }

  // Field mapping for this version.
  let sentBody = opts.body;
  const spec = op.mapRequest?.[version];
  if (spec && opts.body !== undefined) {
    const mapped = mapEntity(spec, opts.body);
    if (mapped.errors.length) {
      return finish({ ok: false, status: null, data: null, attempts: [], fromCache: false, version, sentBody: mapped.output, mappingErrors: mapped.errors, error: "Mapping failed; nothing was sent." }, op.method, path);
    }
    sentBody = mapped.output;
  }

  const attempts: Attempt[] = [];
  let last: Raw | null = null;
  let lastError = "";
  let waitedMs = 0;
  for (let n = 1; n <= def.retry.maxAttempts; n++) {
    waitedMs += await takeToken(def);
    const t0 = Date.now();
    try {
      const auth = await authParts(def);
      const headers = { ...auth.headers, ...(opts.headers ?? {}), ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}), "X-Correlation-Id": correlationId };
      const target = opts.baseUrl ? { ...def, baseUrl: opts.baseUrl } : def;
      last = await send(target, op.method, path, { ...query, ...auth.query }, headers, sentBody, opts.idempotencyKey ?? correlationId, op.bodyFormat);
      const ok = last.status >= 200 && last.status < 300;
      attempts.push({ n, at: new Date(t0).toISOString(), status: last.status, ok, waitedMs, durationMs: Date.now() - t0 });
      if (ok) break;
      lastError = `Partner returned HTTP ${last.status}.`;
      if (!def.retry.retryOn.includes(last.status) || n === def.retry.maxAttempts) break;
      waitedMs = backoff(def.retry, n, last.headers["retry-after"]);
    } catch (e) {
      const credential = e instanceof CredentialError;
      lastError = e instanceof Error ? (e.name === "AbortError" ? `Timed out after ${def.timeoutMs} ms.` : e.message) : "Network error.";
      attempts.push({ n, at: new Date(t0).toISOString(), status: null, ok: false, waitedMs, error: lastError, durationMs: Date.now() - t0 });
      if (credential || n === def.retry.maxAttempts) break; // a missing credential will not fix itself
      waitedMs = backoff(def.retry, n);
    }
    await sleep(waitedMs);
  }

  const ok = Boolean(last && last.status >= 200 && last.status < 300);
  const result: Omit<CallResult, "callId"> = { ok, status: last?.status ?? null, data: last?.data ?? null, attempts, fromCache: false, version, sentBody, error: ok ? undefined : lastError };

  if (ok && idemId) await store.docPut(IDEMPOTENCY, { id: idemId, at: new Date().toISOString(), result: { callId, ...result } });

  if (!ok && !opts.replayOf) {
    const dl: DeadLetter = {
      id: newId("dlq"), at, connectorId, operation: operationId, version,
      request: { bodyEnc: opts.body === undefined ? undefined : encrypt(opts.body), query, params: opts.params }, idempotencyKey: opts.idempotencyKey, correlationId,
      status: result.status, error: lastError, attempts: attempts.length, replays: [], resolved: false
    };
    await store.docPut(DEAD, dl);
    result.deadLetterId = dl.id;
    if (deadLetterListener) await deadLetterListener(dl).catch(() => undefined);
  }
  return finish(result, op.method, path);
}

/** Sends a dead-lettered call again with the same idempotency key and payload. */
export async function replayDeadLetter(id: string): Promise<{ ok: boolean; result?: CallResult; error?: string }> {
  const store = getStore();
  const dl = await store.docGet<DeadLetter>(DEAD, id);
  if (!dl) return { ok: false, error: "Dead letter not found." };
  if (dl.resolved) return { ok: false, error: "This item was already delivered." };
  const result = await callConnector(dl.connectorId, dl.operation, {
    body: dl.request.bodyEnc ? decrypt(dl.request.bodyEnc) : undefined, query: dl.request.query, params: dl.request.params, version: dl.version,
    idempotencyKey: dl.idempotencyKey, correlationId: dl.correlationId, replayOf: dl.id
  });
  dl.replays.push({ at: new Date().toISOString(), ok: result.ok, status: result.status, callId: result.callId });
  if (result.ok) dl.resolved = true;
  await store.docPut(DEAD, dl);
  return { ok: result.ok, result };
}

export const listCalls = async (connectorId?: string) =>
  (await getStore().docList<CallRecord>(CALLS, connectorId ? { connectorId } : undefined)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200);
export const listDeadLetters = async () =>
  (await getStore().docList<DeadLetter>(DEAD)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200);

/** Success rate and latency per connector, from the call log. */
export async function connectorStats() {
  const calls = await getStore().docList<CallRecord>(CALLS);
  const open = (await getStore().docList<DeadLetter>(DEAD)).filter(d => !d.resolved);
  return listConnectors().map(def => {
    const mine = calls.filter(c => c.connectorId === def.id && !c.fromCache);
    const okCount = mine.filter(c => c.ok).length;
    const avg = mine.length ? Math.round(mine.reduce((s, c) => s + c.durationMs, 0) / mine.length) : 0;
    const lastCall = mine.sort((a, b) => b.at.localeCompare(a.at))[0];
    return {
      id: def.id, name: def.name, family: def.family, description: def.description, managedBy: def.managedBy,
      versions: def.versions, defaultVersion: def.defaultVersion, authType: def.auth.type,
      rateLimit: def.rateLimit, retry: def.retry, timeoutMs: def.timeoutMs,
      operations: Object.entries(def.operations).map(([id, o]) => ({
        id, method: o.method, description: o.description ?? "", versions: Object.keys(o.paths),
        params: [...new Set(Object.values(o.paths).flatMap(p => [...p.matchAll(/\{(\w+)\}/g)].map(m => m[1])))]
      })),
      calls: mine.length, successRate: mine.length ? Math.round((okCount / mine.length) * 100) : null, avgMs: avg,
      lastCallAt: lastCall?.at ?? null, openDeadLetters: open.filter(d => d.connectorId === def.id).length
    };
  });
}
