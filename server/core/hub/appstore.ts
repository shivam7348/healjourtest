// Healjour App Store partner layer: third-party apps register, pass a review, and are installed by a centre
// with only the scopes the centre grants. Apps get tokens through OAuth 2.0 (authorization code + refresh),
// call a scoped API that only ever sees the installing centre's data, and receive signed webhooks.
// Apps that are not approved yet can only be installed in the Sandbox Lab, which serves synthetic data.

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getStore } from "../store.js";
import { callConnector, newId } from "../framework/connector.js";
import { decrypt, encrypt } from "../compliance/crypto.js";

export const SCOPES: Record<string, string> = {
  "cases:read": "Read the centre's lab cases (no patient phone or address)",
  "results:read": "Read test results of the centre's cases",
  "bookings:write": "Create bookings for the centre",
  "webhooks:receive": "Receive events (case updated, report ready)"
};
export const SANDBOX_LAB = { id: "sandbox-lab", name: "Sandbox Lab (synthetic data)" };
export const REVIEW_CHECKS: Record<string, string> = {
  privacy: "Privacy policy is published and explains health-data use",
  scopes: "Every requested scope is needed for the app's features",
  security: "Stores tokens server-side; uses HTTPS redirect and webhook URLs",
  sandbox: "Tested end to end against the Sandbox Lab",
  support: "Support contact and escalation path given"
};

export type AppStatus = "draft" | "in_review" | "approved" | "rejected" | "suspended";
export type App = {
  id: string; name: string; developer: string; developerEmail: string; category: string; description: string;
  privacyPolicyUrl: string; redirectUri: string; webhookUrl: string; scopes: string[];
  status: AppStatus; version: number; clientId: string; secretHash: string; webhookSecretEnc: string;
  review?: { checks: Record<string, boolean>; notes: string; by: string; at: string; decision: "approved" | "rejected" };
  history: Array<{ at: string; event: string; detail: string }>;
  createdAt: string; updatedAt: string;
};
export type Installation = { id: string; appId: string; labId: string; labName: string; scopes: string[]; status: "active" | "revoked"; installedBy: string; at: string; revokedAt?: string };
type Code = { id: string; installationId: string; appId: string; redirectUri: string; expiresAt: number; used: boolean };
type Token = { id: string; kind: "access" | "refresh"; installationId: string; appId: string; scopes: string[]; expiresAt: number };

const APPS = "apps", INSTALLS = "appInstallations", CODES = "appAuthCodes", TOKENS = "appTokens";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const now = () => new Date().toISOString();
const hist = (a: App, event: string, detail: string) => { a.history.push({ at: now(), event, detail }); a.updatedAt = now(); };

function hashSecret(secret: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(secret, salt, 32).toString("hex")}`;
}
function checkSecret(secret: string, stored: string) {
  const [, salt, hex] = stored.split("$");
  if (!salt || !hex) return false;
  const a = scryptSync(secret, salt, 32), b = Buffer.from(hex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Webhook and redirect URLs: "sandbox" or public HTTPS (no localhost or private network addresses). */
export function urlProblem(url: string, allowSandbox = true): string | null {
  if (allowSandbox && url === "sandbox") return null;
  let u: URL;
  try { u = new URL(url); } catch { return "Not a valid URL."; }
  if (u.protocol !== "https:") return "Must use https.";
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.startsWith("[")) return "Must be a public address.";
  return null;
}

export function viewApp(a: App) {
  const { secretHash: _s, webhookSecretEnc: _w, ...rest } = a;
  return rest;
}

export async function createApp(input: { name: string; developer: string; developerEmail: string; category: string; description: string; privacyPolicyUrl: string; redirectUri: string; webhookUrl: string; scopes: string[] }) {
  const clientSecret = `hjs_${randomBytes(24).toString("base64url")}`;
  const webhookSecret = `whsec_${randomBytes(24).toString("base64url")}`;
  const a: App = {
    id: newId("app"), ...input, scopes: input.scopes.filter(s => s in SCOPES), status: "draft", version: 1,
    clientId: `hja_${randomBytes(8).toString("hex")}`, secretHash: hashSecret(clientSecret), webhookSecretEnc: encrypt(webhookSecret),
    history: [], createdAt: now(), updatedAt: now()
  };
  hist(a, "created", `Draft with scopes ${a.scopes.join(", ")}`);
  await getStore().docPut(APPS, a);
  return { app: viewApp(a), clientSecret, webhookSecret };   // secrets shown once
}

export async function submitApp(id: string) {
  const store = getStore();
  const a = await store.docGet<App>(APPS, id);
  if (!a) return { ok: false, error: "App not found." };
  if (a.status !== "draft" && a.status !== "rejected") return { ok: false, error: `An app that is ${a.status} cannot be submitted.` };
  a.status = "in_review"; hist(a, "submitted", `Version ${a.version} sent for review`);
  await store.docPut(APPS, a);
  return { ok: true, app: viewApp(a) };
}

export async function reviewApp(id: string, decision: "approved" | "rejected", checks: Record<string, boolean>, notes: string, by: string) {
  const store = getStore();
  const a = await store.docGet<App>(APPS, id);
  if (!a) return { ok: false, error: "App not found." };
  if (a.status !== "in_review") return { ok: false, error: "Only an app in review can be decided." };
  const missing = Object.keys(REVIEW_CHECKS).filter(k => !checks[k]);
  if (decision === "approved" && missing.length) return { ok: false, error: `Approve only when every check passes. Open: ${missing.map(k => REVIEW_CHECKS[k]).join("; ")}.` };
  if (decision === "rejected" && notes.trim().length < 5) return { ok: false, error: "Tell the developer why (notes)." };
  a.status = decision; a.review = { checks, notes, by, at: now(), decision };
  hist(a, decision, notes || "All checks passed");
  await store.docPut(APPS, a);
  return { ok: true, app: viewApp(a) };
}

export async function setAppSuspended(id: string, suspended: boolean) {
  const store = getStore();
  const a = await store.docGet<App>(APPS, id);
  if (!a) return null;
  if (suspended) { a.status = "suspended"; hist(a, "suspended", "All tokens stop working"); }
  else if (a.status === "suspended") { a.status = "approved"; hist(a, "reinstated", "Tokens work again"); }
  await store.docPut(APPS, a);
  return viewApp(a);
}

/**
 * A centre admin installs an app and grants scopes (only ones the app asked for).
 * Returns an authorization code; in production it is sent to the app's redirect URI.
 */
export async function installApp(appId: string, labId: string, labName: string, scopes: string[], by: string) {
  const store = getStore();
  const a = await store.docGet<App>(APPS, appId);
  if (!a) return { ok: false, error: "App not found." };
  if (labId !== SANDBOX_LAB.id && a.status !== "approved") return { ok: false, error: "Only approved apps can be installed in a real centre. Use the Sandbox Lab until review passes." };
  if (a.status === "suspended" || a.status === "rejected") return { ok: false, error: `This app is ${a.status}.` };
  const granted = scopes.filter(s => a.scopes.includes(s));
  if (!granted.length) return { ok: false, error: "Grant at least one of the scopes the app asked for." };
  const inst: Installation = { id: newId("inst"), appId, labId, labName, scopes: granted, status: "active", installedBy: by, at: now() };
  await store.docPut(INSTALLS, inst);
  const code = `hjc_${randomBytes(20).toString("base64url")}`;
  await store.docPut(CODES, { id: sha(code), installationId: inst.id, appId, redirectUri: a.redirectUri, expiresAt: Date.now() + 10 * 60_000, used: false } satisfies Code);
  hist(a, "installed", `${labName} granted ${granted.join(", ")}`);
  await store.docPut(APPS, a);
  const redirect = a.redirectUri === "sandbox" ? null : `${a.redirectUri}${a.redirectUri.includes("?") ? "&" : "?"}code=${encodeURIComponent(code)}`;
  return { ok: true, installation: inst, code, redirect };
}

export async function revokeInstallation(id: string) {
  const store = getStore();
  const inst = await store.docGet<Installation>(INSTALLS, id);
  if (!inst) return null;
  inst.status = "revoked"; inst.revokedAt = now();
  await store.docPut(INSTALLS, inst);
  await store.docDeleteWhere(TOKENS, { installationId: id });
  return inst;
}

async function issueTokens(inst: Installation) {
  const store = getStore();
  const access = `hjt_${randomBytes(24).toString("base64url")}`;
  const refresh = `hjr_${randomBytes(24).toString("base64url")}`;
  await store.docPut(TOKENS, { id: sha(access), kind: "access", installationId: inst.id, appId: inst.appId, scopes: inst.scopes, expiresAt: Date.now() + 3600_000 } satisfies Token);
  await store.docPut(TOKENS, { id: sha(refresh), kind: "refresh", installationId: inst.id, appId: inst.appId, scopes: inst.scopes, expiresAt: Date.now() + 30 * 86_400_000 } satisfies Token);
  return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: inst.scopes.join(" ") };
}

/** OAuth 2.0 token endpoint: authorization_code and refresh_token grants, client authenticated by secret. */
export async function tokenGrant(body: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const store = getStore();
  const err = (status: number, error: string, description: string) => ({ status, body: { error, error_description: description } });
  const app = (await store.docList<App>(APPS, { clientId: body.client_id ?? "" }))[0];
  if (!app || !body.client_secret || !checkSecret(body.client_secret, app.secretHash)) return err(401, "invalid_client", "Client authentication failed.");
  if (app.status === "suspended" || app.status === "rejected") return err(401, "invalid_client", `App is ${app.status}.`);
  if (body.grant_type === "authorization_code") {
    const code = await store.docGet<Code>(CODES, sha(body.code ?? ""));
    if (!code || code.used || code.expiresAt < Date.now() || code.appId !== app.id) return err(400, "invalid_grant", "Code is invalid, used or expired.");
    if ((body.redirect_uri ?? app.redirectUri) !== code.redirectUri) return err(400, "invalid_grant", "redirect_uri does not match.");
    code.used = true; await store.docPut(CODES, code);
    const inst = await store.docGet<Installation>(INSTALLS, code.installationId);
    if (!inst || inst.status !== "active") return err(400, "invalid_grant", "Installation is no longer active.");
    return { status: 200, body: await issueTokens(inst) };
  }
  if (body.grant_type === "refresh_token") {
    const tok = await store.docGet<Token>(TOKENS, sha(body.refresh_token ?? ""));
    if (!tok || tok.kind !== "refresh" || tok.expiresAt < Date.now() || tok.appId !== app.id) return err(400, "invalid_grant", "Refresh token is invalid or expired.");
    const inst = await store.docGet<Installation>(INSTALLS, tok.installationId);
    if (!inst || inst.status !== "active") return err(400, "invalid_grant", "Installation is no longer active.");
    await store.docDelete(TOKENS, tok.id);   // refresh tokens are single-use (rotation)
    return { status: 200, body: await issueTokens(inst) };
  }
  return err(400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
}

/** Checks an app's bearer token and scope. Returns the installation the call is limited to. */
export async function authorizeAppCall(authHeader: string | undefined, scope: string): Promise<{ inst?: Installation; error?: string; status?: number }> {
  const token = /^Bearer\s+(.+)$/i.exec(authHeader ?? "")?.[1];
  if (!token) return { status: 401, error: "Missing bearer token." };
  const store = getStore();
  const tok = await store.docGet<Token>(TOKENS, sha(token));
  if (!tok || tok.kind !== "access" || tok.expiresAt < Date.now()) return { status: 401, error: "Token is invalid or expired." };
  const app = await store.docGet<App>(APPS, tok.appId);
  if (!app || app.status === "suspended" || app.status === "rejected") return { status: 401, error: "App is not active." };
  if (!tok.scopes.includes(scope)) return { status: 403, error: `This token does not have the ${scope} scope.` };
  const inst = await store.docGet<Installation>(INSTALLS, tok.installationId);
  if (!inst || inst.status !== "active") return { status: 401, error: "Installation was revoked." };
  return { inst };
}

/** Synthetic cases for the Sandbox Lab (never real patients). */
export const SANDBOX_CASES = [
  { caseNo: "SBX-1001", status: "report_ready", tests: ["CBC", "HbA1c"], patient: { initials: "R.S.", age: 32, gender: "male" }, createdAt: "2026-11-10T09:00:00.000Z",
    results: [{ testName: "Haemoglobin", value: "13.4", unit: "g/dL", referenceRange: "13–17", flag: "normal" }, { testName: "HbA1c", value: "6.1", unit: "%", referenceRange: "4–5.6", flag: "high" }] },
  { caseNo: "SBX-1002", status: "processing", tests: ["Lipid profile"], patient: { initials: "A.D.", age: 45, gender: "female" }, createdAt: "2026-11-12T11:30:00.000Z", results: [] }
];

/** Signs and delivers an event to one installation's app. */
export async function sendAppEvent(installationId: string, type: string, data: unknown) {
  const store = getStore();
  const inst = await store.docGet<Installation>(INSTALLS, installationId);
  if (!inst || inst.status !== "active") return { ok: false, error: "Installation is not active." };
  if (!inst.scopes.includes("webhooks:receive")) return { ok: false, error: "The centre did not grant webhooks:receive." };
  const app = await store.docGet<App>(APPS, inst.appId);
  if (!app) return { ok: false, error: "App not found." };
  const body = { id: newId("evt"), type, created: Math.floor(Date.now() / 1000), installation: inst.id, lab: inst.labId, data };
  const raw = JSON.stringify(body);
  const signature = `sha256=${createHmac("sha256", decrypt<string>(app.webhookSecretEnc)).update(raw).digest("hex")}`;
  const result = await callConnector("app-webhooks", "deliver", {
    baseUrl: app.webhookUrl === "sandbox" ? "mock://app-receiver" : app.webhookUrl,
    query: { app: app.id }, headers: { "X-Healjour-Signature": signature, "X-Healjour-Event": type }, body, idempotencyKey: body.id
  });
  return { ok: result.ok, status: result.status, error: result.error, eventId: body.id };
}

export const listApps = async () => (await getStore().docList<App>(APPS)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(viewApp);
export const listInstallations = async () => (await getStore().docList<Installation>(INSTALLS)).sort((a, b) => b.at.localeCompare(a.at));
