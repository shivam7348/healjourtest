// Reads the Flabs report PDF (reportURL) and pulls out each parameter's reference range.
// Layout it understands (one parameter per line):  "Haemoglobin (Hb)  12  10 - 50"
//                                                or "DLC-Lymphocytes  5  L  12.0 - 30.0  %"
// Lines that do not match this pattern are ignored, so headers and dates never become ranges.

import { extractText, getDocumentProxy } from "unpdf";
import { getStore } from "../store.js";
import type { FlabsResultRecord } from "./webhooks.js";

export type RefRange = { name: string; unit: string; low: number; high: number; labFlag?: "L" | "H" };

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
// Only Flabs' report storage (Amazon S3) is fetched from the server.
const ALLOWED_HOST = /(^|\.)amazonaws\.com$/i;
const NOT_A_PARAMETER = /\b(date|report|barcode|phone|patient|age|sample|status|referred|collection|name|doctor)\b/i;

const LINE = /^(.+?)\s+(-?\d+(?:\.\d+)?)\s+(?:([LH])\s+)?(\d+(?:\.\d+)?)\s+-\s+(\d+(?:\.\d+)?)\s*(.*)$/;

/** Parses the report text into reference ranges. The first occurrence of a name wins (summary before details). */
export function extractRanges(text: string): RefRange[] {
  const out: RefRange[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = LINE.exec(line);
    if (!m) continue;
    const name = m[1].trim();
    if (name.length < 2 || name.includes(":") || NOT_A_PARAMETER.test(name)) continue;
    const low = Number(m[4]);
    const high = Number(m[5]);
    if (!Number.isFinite(low) || !Number.isFinite(high) || low > high) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, unit: m[6].trim(), low, high, ...(m[3] ? { labFlag: m[3] as "L" | "H" } : {}) });
  }
  return out;
}

/** Downloads the PDF from an allowed Flabs address and returns its text. */
export async function readReportText(url: string): Promise<string> {
  const u = new URL(url);
  if (u.protocol !== "https:" || !ALLOWED_HOST.test(u.hostname)) throw new Error("The report link is not a Flabs report address.");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(u, { signal: ac.signal });
    if (!res.ok) throw new Error(`Report could not be downloaded (HTTP ${res.status}).`);
    if (!(res.headers.get("content-type") ?? "").includes("pdf")) throw new Error("The report link is not a PDF.");
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_PDF_BYTES) throw new Error("The report is too large to read.");
    const pdf = await getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Reads the report for one bill and saves its ranges on the bill's result record. */
export async function refreshRecordRanges(id: string): Promise<{ ok: boolean; count: number; error?: string }> {
  const store = getStore();
  const rec = await store.docGet<FlabsResultRecord>("flabsResults", id);
  if (!rec) return { ok: false, count: 0, error: "No results saved for this bill." };
  if (!rec.reportUrl) return { ok: false, count: 0, error: "This bill has no report link yet." };
  const now = new Date().toISOString();
  try {
    const ranges = extractRanges(await readReportText(rec.reportUrl));
    await store.docPut("flabsResults", {
      ...rec,
      refRanges: ranges,
      refExtractedAt: now,
      refError: ranges.length ? undefined : "No reference ranges were found in the report."
    });
    return { ok: ranges.length > 0, count: ranges.length, error: ranges.length ? undefined : "No reference ranges were found in the report." };
  } catch (e) {
    const message = e instanceof Error ? e.message : "The report could not be read.";
    await store.docPut("flabsResults", { ...rec, refRanges: rec.refRanges ?? [], refExtractedAt: now, refError: message });
    return { ok: false, count: 0, error: message };
  }
}
