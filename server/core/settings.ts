// App settings that can be set from the Settings screen. They are kept in a local file
// (.secrets/app.env, git-ignored) so they survive restarts without editing environment variables.
// The encryption key is never returned to the browser: the screen only shows whether it exists.
//
// MongoDB credentials are deliberately NOT managed here; they stay in the environment.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Next.js runs from the project root, both in dev and in production.
export const SETTINGS_DIR = resolve(process.cwd(), ".secrets");
export const SETTINGS_FILE = resolve(SETTINGS_DIR, "app.env");

// Vercel's filesystem is read-only: there, these values live in Project Settings → Environment Variables.
const ON_VERCEL = Boolean(process.env.VERCEL);
export const VERCEL_SETTINGS_MESSAGE =
  "On Vercel, set this in Project Settings → Environment Variables (FLABS_SECRET_KEY, PUBLIC_BASE_URL), then redeploy.";

const MANAGED_KEYS = ["FLABS_SECRET_KEY", "PUBLIC_BASE_URL"] as const;
type ManagedKey = (typeof MANAGED_KEYS)[number];

function readFile(): Record<string, string> {
  if (!existsSync(SETTINGS_FILE)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(SETTINGS_FILE, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function writeFile(values: Record<string, string>) {
  if (ON_VERCEL) throw new Error(VERCEL_SETTINGS_MESSAGE);
  mkdirSync(SETTINGS_DIR, { recursive: true });
  const body = Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  writeFileSync(SETTINGS_FILE, body, { encoding: "utf8" });
}

/** Called once at startup. Values already in the environment win over the file. */
export function loadSettingsFile() {
  for (const [key, value] of Object.entries(readFile())) {
    if (!process.env[key]) process.env[key] = value;
  }
}

export function settingsStatus() {
  return {
    encryptionKeySet: Boolean(process.env.FLABS_SECRET_KEY?.trim()),
    publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "") || null,
    settingsFile: ".secrets/app.env"
  };
}

/** Creates the encryption key once. Refuses to replace it, because saved secrets depend on it. */
export function generateEncryptionKey(): { created: boolean } {
  if (process.env.FLABS_SECRET_KEY?.trim()) return { created: false };
  if (ON_VERCEL) throw new Error(VERCEL_SETTINGS_MESSAGE);
  const key = randomBytes(32).toString("base64");
  process.env.FLABS_SECRET_KEY = key;
  writeFile({ ...readFile(), FLABS_SECRET_KEY: key });
  return { created: true };
}

export function setPublicBaseUrl(url: string) {
  const clean = url.trim().replace(/\/$/, "");
  if (!/^https:\/\/[^\s/]+/.test(clean)) throw new Error("The address must start with https:// (Flabs cannot call plain http).");
  if (ON_VERCEL) throw new Error(VERCEL_SETTINGS_MESSAGE);
  process.env.PUBLIC_BASE_URL = clean;
  const values = readFile();
  values.PUBLIC_BASE_URL = clean;
  writeFile(values);
  return clean;
}

export const isManagedKey = (k: string): k is ManagedKey => (MANAGED_KEYS as readonly string[]).includes(k);
