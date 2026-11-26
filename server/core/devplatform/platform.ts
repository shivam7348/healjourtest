// Healjour Developer Platform: developer accounts, API apps (client ID + secret), tokens and rate limits.
//
// Developer account   Self-serve sign-up on /developers. Separate from admin and lab users (own session cookie),
//                     so a developer login can never reach admin screens.
// API app (client)    kind "partner": created by a developer. Creates bookings and reads ONLY the bookings it created.
//                     kind "lab":     created by a lab admin in the Lab Portal. Reads its lab's bookings and pushes
//                                     status, results and reports for that lab only.
// Tokens              POST /api/v1/auth/token with clientId + clientSecret -> 1-hour access token + 30-day refresh token.
//                     Only SHA-256 hashes of secrets and tokens are stored.

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { getStore } from "../store.js";
import { readCookie } from "../portal/auth.js";

export const DEV_ACCOUNTS = "devAccounts";
export const DEV_SESSIONS = "devSessions";
export const API_CLIENTS = "apiClients";
const API_TOKENS = "apiTokens";
const DEV_COOKIE = "hj_dev";
const SESSION_HOURS = 24 * 7;
export const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;

export type DevAccount = { id: string; name: string; email: string; company: string; passwordHash: string; active: boolean; createdAt: string; lastLoginAt?: string };
export type ApiClient = {
  id: string; clientId: string; secretHash: string; name: string; description: string;
  kind: "partner" | "lab";
  ownerType: "developer" | "lab"; ownerId: string;      // developer account id, or lab id
  labId?: string;                                      // kind "lab": the only lab it can see
  createdBy: { id: string; name: string; email: string };
  active: boolean; createdAt: string; rotatedAt?: string; lastUsedAt?: string; revokedAt?: string; revokedBy?: string;
};
type ApiToken = { id: string; kind: "access" | "refresh"; clientId: string; expiresAt: string };

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const newId = (p: string) => `${p}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
const nowIso = () => new Date().toISOString();

// ---------- developer accounts and sessions ----------
export async function createDevSession(req: Request, res: Response, account: DevAccount) {
  const token = randomBytes(32).toString("base64url");
  await getStore().docPut(DEV_SESSIONS, { id: sha(token), accountId: account.id, createdAt: nowIso(), expiresAt: new Date(Date.now() + SESSION_HOURS * 3600_000).toISOString() });
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.setHeader("Set-Cookie", `${DEV_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}${secure ? "; Secure" : ""}`);
}
export async function endDevSession(req: Request, res: Response) {
  const token = readCookie(req, DEV_COOKIE);
  if (token) await getStore().docDelete(DEV_SESSIONS, sha(token));
  res.setHeader("Set-Cookie", `${DEV_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
export async function currentDeveloper(req: Request): Promise<DevAccount | null> {
  const token = readCookie(req, DEV_COOKIE);
  if (!token) return null;
  const s = await getStore().docGet<{ id: string; accountId: string; expiresAt: string }>(DEV_SESSIONS, sha(token));
  if (!s || Date.parse(s.expiresAt) < Date.now()) return null;
  const a = await getStore().docGet<DevAccount>(DEV_ACCOUNTS, s.accountId);
  return a?.active ? a : null;
}
export const publicAccount = ({ passwordHash: _h, ...a }: DevAccount) => a;

// ---------- API apps ----------
function hashSecret(secret: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(secret, salt, 32).toString("hex")}`;
}
function secretMatches(secret: string, stored: string) {
  const [salt, hex] = stored.split(":");
  if (!salt || !hex) return false;
  const a = scryptSync(secret, salt, 32), b = Buffer.from(hex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
const makeSecret = () => `hjsk_${randomBytes(32).toString("base64url")}`;

export async function createClient(input: Omit<ApiClient, "id" | "clientId" | "secretHash" | "active" | "createdAt">) {
  const secret = makeSecret();
  const client: ApiClient = {
    ...input, id: newId("app"), clientId: `hjc_${input.kind === "lab" ? "lab_" : ""}${randomBytes(10).toString("hex")}`,
    secretHash: hashSecret(secret), active: true, createdAt: nowIso()
  };
  await getStore().docPut(API_CLIENTS, client);
  return { client, secret };
}
export async function rotateSecret(client: ApiClient) {
  const secret = makeSecret();
  const next = { ...client, secretHash: hashSecret(secret), rotatedAt: nowIso() };
  await getStore().docPut(API_CLIENTS, next);
  await getStore().docDeleteWhere(API_TOKENS, { clientId: client.clientId }); // old tokens stop working
  return { client: next, secret };
}
export async function revokeClient(client: ApiClient, by: string) {
  await getStore().docPut(API_CLIENTS, { ...client, active: false, revokedAt: nowIso(), revokedBy: by });
  await getStore().docDeleteWhere(API_TOKENS, { clientId: client.clientId });
}
export const publicClient = ({ secretHash: _h, ...c }: ApiClient) => c;
export const findClient = async (clientId: string) => (await getStore().docList<ApiClient>(API_CLIENTS, { clientId }))[0];

// ---------- tokens ----------
async function issueTokens(clientId: string) {
  const access = `hjat_${randomBytes(32).toString("base64url")}`, refresh = `hjrt_${randomBytes(32).toString("base64url")}`;
  await getStore().docPut<ApiToken>(API_TOKENS, { id: sha(access), kind: "access", clientId, expiresAt: new Date(Date.now() + ACCESS_TTL_S * 1000).toISOString() });
  await getStore().docPut<ApiToken>(API_TOKENS, { id: sha(refresh), kind: "refresh", clientId, expiresAt: new Date(Date.now() + REFRESH_TTL_S * 1000).toISOString() });
  return { accessToken: access, refreshToken: refresh, tokenType: "Bearer", expiresIn: ACCESS_TTL_S };
}
export async function tokenForCredentials(clientId: string, secret: string) {
  const client = await findClient(clientId);
  if (!client || !client.active || !secretMatches(secret, client.secretHash)) return null;
  return issueTokens(client.clientId);
}
export async function tokenForRefresh(refreshToken: string) {
  const t = await getStore().docGet<ApiToken>(API_TOKENS, sha(refreshToken));
  if (!t || t.kind !== "refresh" || Date.parse(t.expiresAt) < Date.now()) return null;
  const client = await findClient(t.clientId);
  if (!client?.active) return null;
  await getStore().docDelete(API_TOKENS, t.id); // refresh tokens are single-use
  return issueTokens(client.clientId);
}
export async function clientForAccessToken(token: string): Promise<ApiClient | null> {
  const t = await getStore().docGet<ApiToken>(API_TOKENS, sha(token));
  if (!t || t.kind !== "access" || Date.parse(t.expiresAt) < Date.now()) return null;
  const client = await findClient(t.clientId);
  return client?.active ? client : null;
}

// ---------- rate limit and recent requests (per server instance) ----------
export const RATE_LIMIT = 120; // requests per minute per app
const windows = new Map<string, number[]>();
export function takeRateLimit(clientId: string) {
  const now = Date.now();
  const hits = (windows.get(clientId) ?? []).filter(t => now - t < 60_000);
  const allowed = hits.length < RATE_LIMIT;
  if (allowed) hits.push(now);
  windows.set(clientId, hits);
  return { allowed, remaining: Math.max(0, RATE_LIMIT - hits.length), resetSeconds: hits.length ? Math.ceil((60_000 - (now - hits[0])) / 1000) : 60 };
}
export type RequestLog = { at: string; method: string; path: string; status: number; ms: number; requestId: string };
const recent = new Map<string, RequestLog[]>();
export function logRequest(clientId: string, entry: RequestLog) {
  const list = recent.get(clientId) ?? [];
  list.unshift(entry);
  recent.set(clientId, list.slice(0, 100));
}
export const recentRequests = (clientId: string) => recent.get(clientId) ?? [];

export async function touchClient(client: ApiClient) {
  // At most once a minute, so busy apps do not write on every call.
  if (client.lastUsedAt && Date.now() - Date.parse(client.lastUsedAt) < 60_000) return;
  await getStore().docPut(API_CLIENTS, { ...client, lastUsedAt: nowIso() });
}
