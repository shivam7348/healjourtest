// Registry of Flabs accounts. Several can be connected at once: one per lab, one per
// corporate, one per referring doctor or hospital. Each has its own label, branch, phase,
// optional party (corporate scope) and its own secret.
//
// Where secrets live:
//   - FLABS_SECRET_KEY set      -> each secret is sealed (AES-256-GCM) in MongoDB; survives restarts.
//   - FLABS_SECRET_KEY not set  -> secrets stay in server memory only; lost on restart.
// The browser never receives a secret, only a masked client ID.

import { randomBytes } from "node:crypto";
import { getStore } from "../store.js";
import type { FlabsParty } from "../models.js";
import type { StoredFlabsConnection } from "../models.js";
import type { FlabsConfig, FlabsPhase } from "./client.js";
import { canPersistSecret, openSecret, sealSecret } from "./vault.js";

type Entry = {
  config: FlabsConfig;
  isDefault: boolean;
  secretStorage: "encrypted" | "memory" | "env";
  updatedAt: string;
};

const registry = new Map<string, Entry>();

/** Environment-variable account, used only when nothing was saved from the UI. */
function envFlabsConfig(): FlabsConfig | undefined {
  const clientId = process.env.FLABS_CLIENT_ID?.trim();
  const clientSecret = process.env.FLABS_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return undefined;
  return {
    id: "env",
    label: "Environment connection",
    baseUrl: (process.env.FLABS_BASE_URL?.trim() || "https://v2.flabs.in").replace(/\/$/, ""),
    clientId,
    clientSecret,
    branchId: process.env.FLABS_BRANCH_ID?.trim() || undefined,
    phase: process.env.FLABS_PHASE === "lead" ? "lead" : "booking"
  };
}

export type ConnectionInput = {
  id?: string;               // omit to create a new connection
  label: string;
  clientId: string;
  clientSecret?: string;     // optional on edit: keeps the saved secret for the same client ID
  baseUrl: string;
  branchId: string;
  phase: FlabsPhase;
  party?: FlabsParty;
  makeDefault?: boolean;
};

const maskClientId = (value: string) => (value.length <= 6 ? "••••" : `${value.slice(0, 4)}••••${value.slice(-2)}`);

function ensureDefault() {
  if (registry.size === 0) return;
  if (![...registry.values()].some(e => e.isDefault)) [...registry.values()][0].isDefault = true;
}

/** Called once at startup, after the store is connected. */
export async function loadFlabsConnections() {
  registry.clear();
  const storedAll = await getStore().listFlabsConnections();
  for (const stored of storedAll) {
    if (!canPersistSecret()) break;
    try {
      registry.set(stored.id, {
        config: {
          id: stored.id, label: stored.label, baseUrl: stored.baseUrl, clientId: stored.clientId,
          clientSecret: openSecret(stored.secret), branchId: stored.branchId, phase: stored.phase, party: stored.party,
          webhookToken: stored.webhookToken
        },
        isDefault: stored.isDefault,
        secretStorage: "encrypted",
        updatedAt: stored.updatedAt
      });
    } catch {
      console.warn(`Flabs: saved connection "${stored.label}" could not be decrypted. Check FLABS_SECRET_KEY, or re-enter it.`);
    }
  }
  if (storedAll.length && !canPersistSecret()) {
    console.warn("Flabs: saved connections exist but FLABS_SECRET_KEY is not set, so they are unusable. Re-enter them in the Test Catalog screen.");
  }
  const fromEnv = envFlabsConfig();
  if (fromEnv && registry.size === 0) {
    registry.set("env", { config: fromEnv, isDefault: true, secretStorage: "env", updatedAt: new Date().toISOString() });
  }
  ensureDefault();
}

async function persist(entry: Entry) {
  const store = getStore();
  const sealed = sealSecret(entry.config.clientSecret); // undefined when FLABS_SECRET_KEY is not set
  if (sealed && entry.config.id !== "env") {
    await store.saveFlabsConnection({
      id: entry.config.id, label: entry.config.label, clientId: entry.config.clientId, baseUrl: entry.config.baseUrl,
      branchId: entry.config.branchId ?? "", phase: entry.config.phase, party: entry.config.party,
      isDefault: entry.isDefault, secret: sealed, webhookToken: entry.config.webhookToken, updatedAt: entry.updatedAt
    });
    entry.secretStorage = "encrypted";
  } else {
    // No key: write nothing secret. Drop any older saved copy so it cannot reload later.
    await store.deleteFlabsConnection(entry.config.id);
    entry.secretStorage = "memory";
  }
}

/** Creates or updates a connection. The caller must have tested the login first. */
export async function saveFlabsConnection(input: ConnectionInput) {
  const id = input.id ?? `fc-${randomBytes(4).toString("hex")}`;
  const clientId = input.clientId.trim();
  const existing = registry.get(id);
  const clientSecret = input.clientSecret?.trim() || (existing && existing.config.clientId === clientId ? existing.config.clientSecret : "");
  if (!clientSecret) throw new Error("Client Secret is required.");

  const entry: Entry = {
    config: {
      id,
      label: input.label.trim() || clientId,
      clientId,
      clientSecret,
      baseUrl: input.baseUrl.trim().replace(/\/$/, ""),
      branchId: input.branchId.trim(),
      phase: input.phase,
      party: input.party,
      webhookToken: existing?.config.webhookToken
    },
    isDefault: input.makeDefault || existing?.isDefault || registry.size === 0,
    secretStorage: "memory",
    updatedAt: new Date().toISOString()
  };

  if (input.makeDefault) for (const other of registry.values()) other.isDefault = false;
  registry.set(id, entry);
  await persist(entry);
  if (input.makeDefault) for (const other of registry.values()) if (other !== entry) await persist(other);
  ensureDefault();
  return connectionView(id)!;
}

export async function setDefaultConnection(id: string) {
  const entry = registry.get(id);
  if (!entry) return undefined;
  for (const other of registry.values()) other.isDefault = false;
  entry.isDefault = true;
  for (const other of registry.values()) await persist(other);
  return connectionView(id);
}

export async function deleteFlabsConnection(id: string) {
  if (!registry.has(id)) return false;
  registry.delete(id);
  await getStore().deleteFlabsConnection(id);
  ensureDefault();
  return true;
}

/** Config for one account, or the default when no id is given. Used by sync and delivery. */
export function getFlabsConfig(id?: string): FlabsConfig | undefined {
  if (id) return registry.get(id)?.config;
  return [...registry.values()].find(e => e.isDefault)?.config;
}

/** Every connected account. Orders go to all of them unless a run names specific ones. */
export function allFlabsConfigs(): FlabsConfig[] {
  return [...registry.values()].map(e => e.config);
}

/** Safe to send to the browser: no secret, client ID masked. */
export function connectionView(id: string) {
  const entry = registry.get(id);
  if (!entry) return undefined;
  const c = entry.config;
  return {
    id: c.id,
    label: c.label,
    clientIdMasked: maskClientId(c.clientId),
    baseUrl: c.baseUrl,
    branchId: c.branchId ?? null,
    phase: c.phase,
    party: c.party ?? null,
    isDefault: entry.isDefault,
    secretStorage: entry.secretStorage
  };
}

export function listConnectionViews() {
  return [...registry.keys()].map(id => connectionView(id)!);
}

export const canPersistFlabsSecrets = canPersistSecret;

/** Stores the webhook token for an account and persists it. */
export async function setWebhookToken(id: string, token: string) {
  const entry = registry.get(id);
  if (!entry) return undefined;
  entry.config = { ...entry.config, webhookToken: token };
  entry.updatedAt = new Date().toISOString();
  await persist(entry);
  return entry.config;
}

/** Finds the account a webhook token belongs to. */
export function findByWebhookToken(token: string): FlabsConfig | undefined {
  return [...registry.values()].map(e => e.config).find(c => c.webhookToken === token);
}
