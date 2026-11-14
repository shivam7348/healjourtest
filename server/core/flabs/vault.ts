// Encrypts the Flabs client secret before it is written to MongoDB.
//
// Key: FLABS_SECRET_KEY, a 32-byte key in base64. Generate one once with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
// Without it, the secret is never written to disk; it lives in server memory until restart.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type SealedSecret = { iv: string; tag: string; data: string };

function key(): Buffer | undefined {
  const raw = process.env.FLABS_SECRET_KEY?.trim();
  if (!raw) return undefined;
  const buffer = Buffer.from(raw, "base64");
  if (buffer.length !== 32) throw new Error("FLABS_SECRET_KEY must decode to exactly 32 bytes (base64).");
  return buffer;
}

export const canPersistSecret = () => Boolean(key());

export function sealSecret(plain: string): SealedSecret | undefined {
  const k = key();
  if (!k) return undefined;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export function openSecret(sealed: SealedSecret): string {
  const k = key();
  if (!k) throw new Error("FLABS_SECRET_KEY is required to read the stored Flabs secret.");
  const decipher = createDecipheriv("aes-256-gcm", k, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
}
