// Field-level encryption for patient data at rest (DPDP Act / ABDM: protect personal and health data).
// AES-256-GCM with a random 12-byte IV per value; the auth tag detects tampering.
// Searchable fields (phone, email) also get a keyed HMAC "blind index", so we can find a record
// by phone without storing the phone in clear text.
//
// Key: DATA_ENCRYPTION_KEY = 32 random bytes, base64 (e.g. `openssl rand -base64 32`).
// Without it a fixed development key is used and the Compliance page warns about it.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";
let warned = false;

function key(): Buffer {
  const raw = process.env.DATA_ENCRYPTION_KEY?.trim();
  if (raw) {
    const buf = Buffer.from(raw, "base64");
    if (buf.length === 32) return buf;
    throw new Error("DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded.");
  }
  if (!warned) { console.warn("DATA_ENCRYPTION_KEY is not set: using the development key. Set it before storing real patient data."); warned = true; }
  return createHash("sha256").update("healjour-development-key-not-for-production").digest();
}

export const encryptionStatus = () => ({
  algorithm: "AES-256-GCM",
  keyConfigured: Boolean(process.env.DATA_ENCRYPTION_KEY?.trim()),
  keyFingerprint: createHash("sha256").update(key()).digest("hex").slice(0, 12)
});

export const isEncrypted = (v: unknown): v is string => typeof v === "string" && v.startsWith(PREFIX);

/** Encrypts any JSON value. Returns "enc:v1:<iv>.<tag>.<data>" (base64url parts). */
export function encrypt(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value ?? null), "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${data.toString("base64url")}`;
}

/** Decrypts a value made by encrypt(). Plain (old, unencrypted) values are returned as they are. */
export function decrypt<T = unknown>(value: unknown): T {
  if (!isEncrypted(value)) return value as T;
  const [iv, tag, data] = value.slice(PREFIX.length).split(".");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const text = Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  return JSON.parse(text) as T;
}

/** Keyed, deterministic hash for lookups ("find the lead with this phone") without storing the phone in clear. */
export function blindIndex(kind: string, value: string): string {
  const norm = kind === "phone" ? value.replace(/\D/g, "").slice(-10) : value.trim().toLowerCase();
  return createHmac("sha256", key()).update(`${kind}:${norm}`).digest("hex").slice(0, 32);
}

/** Shows only the end of a value, e.g. "******3210". */
export const mask = (value: string, keep = 4) => (value.length <= keep ? value : `${"*".repeat(Math.max(0, value.length - keep))}${value.slice(-keep)}`);
