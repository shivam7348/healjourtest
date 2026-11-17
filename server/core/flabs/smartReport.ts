// Smart report: turns a received Flabs result into a Healjour-branded report.
// Reference range for each parameter, in order of priority:
//   1. the range printed on the lab's report PDF (read by reportRanges.ts)
//   2. the range the admin set in the Results tool (fallback)
// No range from either source = the value is shown without a flag (we never guess medical limits).

import { createHash } from "node:crypto";
import type { FlabsResultRecord } from "./webhooks.js";

export type ParameterRange = { name: string; unit?: string; low?: number; high?: number };

export type ReportParam = {
  name: string; value: string; unit: string; range: string;
  flag: "NORMAL" | "LOW" | "HIGH" | "—";
  labFlag: "L" | "H" | "";          // the flag printed by the lab, if any
  source: "report" | "admin" | "none";
  mismatch: boolean;                // our flag disagrees with the lab's flag
};
export type ReportTest = { testName: string; status: string; parameters: ReportParam[] };
export type SmartReport = {
  reportId: string;
  verifyCode: string;
  generatedAt: string;
  patient: { name: string; contact: string };
  bill: { billId: string; bookingId: string; leadId?: string; account: string; receivedAt: string };
  reportUrl?: string;
  rangeNote?: string;               // why ranges are missing, if they are
  tests: ReportTest[];
  summary: { parameters: number; normal: number; low: number; high: number; unflagged: number; mismatches: number };
};

const norm = (s: string) => s.trim().toLowerCase();
const toNumber = (v: string) => {
  const n = Number(String(v).replace(/,/g, "").match(/-?\d+(\.\d+)?/)?.[0]);
  return Number.isFinite(n) ? n : null;
};

/** Healjour report ID and short verification code, stable for the same bill. */
function identity(billId: string) {
  const hex = createHash("sha256").update(`healjour:${billId}`).digest("hex").toUpperCase();
  return { reportId: `HJR-${hex.slice(0, 10)}`, verifyCode: hex.slice(10, 18) };
}

type Band = { low?: number; high?: number; unit: string; source: "report" | "admin" };

export function buildSmartReport(rec: FlabsResultRecord, adminRanges: ParameterRange[]): SmartReport {
  const fromReport = new Map((rec.refRanges ?? []).map(r => [norm(r.name), r]));
  const fromAdmin = new Map(adminRanges.map(r => [norm(r.name), r]));
  const summary = { parameters: 0, normal: 0, low: 0, high: 0, unflagged: 0, mismatches: 0 };

  const bandFor = (name: string): Band | null => {
    const pdf = fromReport.get(norm(name));
    if (pdf) return { low: pdf.low, high: pdf.high, unit: pdf.unit, source: "report" };
    const adm = fromAdmin.get(norm(name));
    if (adm && (adm.low !== undefined || adm.high !== undefined)) return { low: adm.low, high: adm.high, unit: adm.unit ?? "", source: "admin" };
    return null;
  };

  const tests: ReportTest[] = (rec.tests ?? []).map(t => ({
    testName: t.testName,
    status: t.status,
    parameters: t.parameters.map(p => {
      const band = bandFor(p.name);
      const n = toNumber(p.value);
      const pdf = fromReport.get(norm(p.name));
      const labFlag: "L" | "H" | "" = pdf?.labFlag ?? "";
      let flag: ReportParam["flag"] = "—";
      if (band && n !== null) {
        if (band.low !== undefined && n < band.low) flag = "LOW";
        else if (band.high !== undefined && n > band.high) flag = "HIGH";
        else flag = "NORMAL";
      }
      const mismatch = Boolean(labFlag) && flag !== "—" && ((labFlag === "L" && flag !== "LOW") || (labFlag === "H" && flag !== "HIGH"));
      summary.parameters++;
      if (flag === "NORMAL") summary.normal++;
      else if (flag === "LOW") summary.low++;
      else if (flag === "HIGH") summary.high++;
      else summary.unflagged++;
      if (mismatch) summary.mismatches++;
      const rangeText = band && (band.low !== undefined || band.high !== undefined)
        ? `${band.low ?? ""} – ${band.high ?? ""}`.replace(/^ – | – $/g, "")
        : "";
      return {
        name: p.name, value: p.value, unit: band?.unit || "", range: rangeText, flag,
        labFlag, source: band?.source ?? "none", mismatch
      };
    })
  }));

  const id = identity(rec.id);
  const rangeNote = !rec.refRanges?.length && rec.refError ? rec.refError : undefined;
  return {
    ...id,
    generatedAt: new Date().toISOString(),
    patient: { name: rec.patientName || "—", contact: rec.contact || "" },
    bill: { billId: rec.id, bookingId: rec.integratorID, leadId: rec.leadId, account: rec.account, receivedAt: rec.receivedAt },
    reportUrl: rec.reportUrl,
    rangeNote,
    tests,
    summary
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const FLAG_STYLE: Record<ReportParam["flag"], string> = {
  NORMAL: "background:#e7f9ee;color:#15803d", LOW: "background:#e8f1ff;color:#1d4ed8", HIGH: "background:#fee2e2;color:#b91c1c", "—": "background:#f1f5f9;color:#64748b"
};
const SOURCE_TEXT: Record<ReportParam["source"], string> = { report: "Lab report", admin: "Healjour range", none: "—" };

/** Printable HTML report. Use the browser's "Save as PDF" to keep a copy. */
export function renderSmartReportHtml(r: SmartReport, labName = "Healjour Integration Studio"): string {
  const tests = r.tests.map(t => `
    <section class="test">
      <div class="test-head"><b>${esc(t.testName)}</b><span class="st">${esc(t.status || "")}</span></div>
      ${t.parameters.length ? `<table><thead><tr><th>Parameter</th><th>Result</th><th>Unit</th><th>Reference</th><th>Flag</th><th>Lab flag</th><th>Range from</th></tr></thead><tbody>
        ${t.parameters.map(p => `<tr><td>${esc(p.name)}</td><td><b>${esc(p.value)}</b></td><td>${esc(p.unit)}</td><td>${esc(p.range) || "—"}</td>
        <td><span class="flag" style="${FLAG_STYLE[p.flag]}">${p.flag}</span></td>
        <td>${p.labFlag ? `<b>${p.labFlag}</b>${p.mismatch ? ` <span class="warn">differs</span>` : ""}` : "—"}</td>
        <td class="src">${SOURCE_TEXT[p.source]}</td></tr>`).join("")}
      </tbody></table>` : `<p class="muted">No parameter values reported for this test.</p>`}
    </section>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(r.reportId)} · Smart report</title>
<style>
  body{font-family:Inter,system-ui,sans-serif;color:#0f172a;margin:0;background:#f1f5f9}
  .page{max-width:920px;margin:24px auto;background:#fff;padding:32px 36px;border-radius:12px;box-shadow:0 8px 30px #0f172a14}
  header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #2d5cf2;padding-bottom:16px}
  .brand b{font-size:20px;color:#2d5cf2}.brand small{display:block;color:#64748b;font-size:12px;margin-top:4px}
  .rid{text-align:right;font-size:12.5px;color:#334155}.rid code{font-size:13px;font-weight:700}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;margin:18px 0}
  .grid small{display:block;color:#64748b;font-size:11.5px}.grid div>b{font-size:14px}
  .sum{display:flex;gap:10px;margin:14px 0 6px;flex-wrap:wrap}
  .sum span{padding:6px 12px;border-radius:999px;font-size:12.5px;font-weight:600;background:#f1f5f9}
  .sum span.warn{background:#fef3c7;color:#92400e}
  .test{border:1px solid #e2e8f0;border-radius:10px;margin:14px 0;overflow:hidden}
  .test-head{display:flex;justify-content:space-between;padding:10px 14px;background:#f8fafc;font-size:14px}
  .st{font-size:12px;color:#64748b}
  table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:#64748b;font-size:11.5px;padding:8px 14px;border-bottom:1px solid #e2e8f0}
  td{padding:8px 14px;border-bottom:1px solid #f1f5f9}
  .flag{font-size:11px;font-weight:700;padding:3px 8px;border-radius:6px}
  .src{font-size:12px;color:#64748b}
  .warn{font-size:11px;color:#b45309;font-weight:600}
  .muted{color:#64748b;font-size:13px;padding:8px 14px;margin:0}
  .notice{font-size:12.5px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 12px;margin-top:12px}
  footer{margin-top:22px;padding-top:12px;border-top:1px solid #e2e8f0;font-size:11.5px;color:#64748b;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
  .note{font-size:11.5px;color:#64748b;margin-top:10px}
  @media print{body{background:#fff}.page{box-shadow:none;margin:0;border-radius:0}}
</style></head><body><div class="page">
<header>
  <div class="brand"><b>Healjour</b><small>${esc(labName)} · Smart report</small></div>
  <div class="rid">Report ID<br><code>${esc(r.reportId)}</code><br><small>Verify code ${esc(r.verifyCode)}</small></div>
</header>
<div class="grid">
  <div><small>Patient</small><b>${esc(r.patient.name)}</b></div>
  <div><small>Mobile</small><b>${esc(r.patient.contact || "—")}</b></div>
  <div><small>Bill ID (Flabs)</small><b>${esc(r.bill.billId)}</b></div>
  <div><small>Booking ID (Healjour)</small><b>${esc(r.bill.bookingId)}</b></div>
  <div><small>Account</small><b>${esc(r.bill.account)}</b></div>
  <div><small>Results received</small><b>${esc(when(r.bill.receivedAt))}</b></div>
</div>
<div class="sum">
  <span>Parameters: ${r.summary.parameters}</span><span>Normal: ${r.summary.normal}</span><span>Low: ${r.summary.low}</span><span>High: ${r.summary.high}</span><span>Not flagged: ${r.summary.unflagged}</span>
  ${r.summary.mismatches ? `<span class="warn">Differs from lab flag: ${r.summary.mismatches}</span>` : ""}
</div>
${r.rangeNote ? `<p class="notice">Reference ranges: ${esc(r.rangeNote)}</p>` : ""}
${tests || `<p class="muted">No results have been received for this bill yet.</p>`}
${r.reportUrl ? `<p class="note">Original lab report: <a href="${esc(r.reportUrl)}" target="_blank" rel="noopener noreferrer">open PDF</a></p>` : ""}
<p class="note">Ranges come from the lab's report, or from the Healjour range list when the report has none. Flags compare each value with its range. "Differs" means our flag and the lab's flag disagree and should be checked. This report supports, and does not replace, the clinician's judgement.</p>
<footer><span>Generated by Healjour · ${esc(when(r.generatedAt))}</span><span>Report ${esc(r.reportId)} · verify ${esc(r.verifyCode)}</span></footer>
</div></body></html>`;
}
