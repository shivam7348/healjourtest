// Test Builder: onboard many tests at once and match them to a lab's Flabs tests.
//   draftTests()      free text ("CBC 350, Lipid profile 800 ...") -> test rows to review
//   suggestMatches()  Healjour tests -> the best Flabs test for each, with a confidence and a reason
// Both use Claude when ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) is set, and simple rules otherwise.
// Claude only proposes: staff review every row and mapping before anything is saved.

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";

export const aiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim());
export const aiStatus = () => ({ ai: aiEnabled(), model: aiEnabled() ? MODEL : null });

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic());

/** One structured call: Claude's answer must match `schema`. Throws on refusal or unreadable output. */
async function askJson<T>(system: string, user: string, schema: Record<string, unknown>): Promise<T> {
  const response = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // If a safety classifier declines, the API retries on a suitable fallback model in the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema } },
    system,
    messages: [{ role: "user", content: user }]
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined this request.");
  if (response.stop_reason === "max_tokens") throw new Error("The list is too long for one request. Split it into smaller parts.");
  const text = response.content.find(b => b.type === "text");
  if (!text || text.type !== "text") throw new Error("Claude returned no answer.");
  return JSON.parse(text.text) as T;
}

const aiError = (error: unknown) => {
  if (error instanceof Anthropic.AuthenticationError) return "The Claude API key is not valid.";
  if (error instanceof Anthropic.RateLimitError) return "Claude is rate limited right now. Try again in a minute.";
  if (error instanceof Anthropic.APIError) return `Claude API error ${error.status ?? ""}: ${error.message}`.trim();
  return error instanceof Error ? error.message : "Claude could not answer.";
};

// ---------- 1. Draft test rows from free text ----------

export type DraftRow = { code: string; name: string; sampleType?: string; unit?: string; price: number; loinc?: string };
export type DraftResult = { rows: DraftRow[]; source: "ai" | "rules"; note?: string };

const CODE_RE = /^[A-Z0-9-]{2,30}$/;

/** Short uppercase code from a name: "Complete Blood Count" -> "CBC", "Vitamin D" -> "VITD". Unique within `taken`. */
export function codeFromName(name: string, taken: Set<string>): string {
  // Text in brackets ("Thyroid profile (T3, T4, TSH)") describes the test; it is not part of its code.
  const words = name.replace(/\([^)]*\)/g, " ").toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  let base = words.length >= 3 ? words.map(w => w[0]).join("") : words.join("").slice(0, 8);
  if (base.length < 2) base = (base + "TEST").slice(0, 4);
  base = base.slice(0, 26);
  let code = base;
  for (let i = 2; taken.has(code); i++) code = `${base}-${i}`;
  taken.add(code);
  return code;
}

/** Rules: one test per line or comma; a trailing number is the price; "CODE - Name" keeps the code. */
type Existing = { code: string; name: string };

function draftByRules(text: string, existing: Existing[]): DraftResult {
  const taken = new Set<string>();
  const byName = new Map(existing.map(e => [e.name.trim().toLowerCase(), e.code]));
  const existingCodes = new Set(existing.map(e => e.code));
  const parts = text.split(/\r?\n|;|,(?![^(]*\))/).map(s => s.trim()).filter(Boolean);
  const rows: DraftRow[] = [];
  for (const part of parts) {
    const priceMatch = part.match(/(?:₹|rs\.?|inr)?\s*(\d+(?:\.\d+)?)\s*(?:\/-|rs)?\s*$/i);
    const price = priceMatch ? Number(priceMatch[1]) : 0;
    let rest = (priceMatch ? part.slice(0, priceMatch.index) : part).replace(/[-–:]\s*$/, "").trim();
    let code: string | undefined;
    const codeMatch = rest.match(/^([A-Za-z0-9]{2,12})\s*[-–:]\s*(.+)$/);
    if (codeMatch && CODE_RE.test(codeMatch[1].toUpperCase())) { code = codeMatch[1].toUpperCase(); rest = codeMatch[2].trim(); }
    if (rest.length < 2) continue;
    // Same name or same short code as a catalog test: reuse its code so saving updates it.
    const known = byName.get(rest.toLowerCase()) ?? (existingCodes.has(rest.toUpperCase()) ? rest.toUpperCase() : undefined);
    code = code ?? known;
    if (code && taken.has(code)) code = undefined;
    if (code) taken.add(code);
    rows.push({ code: code ?? codeFromName(rest, taken), name: rest.slice(0, 120), price });
  }
  return { rows, source: "rules" };
}

const draftSchema = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          code: { type: "string" },
          name: { type: "string" },
          sampleType: { type: "string" },
          unit: { type: "string" },
          price: { type: "number" },
          loinc: { type: "string" }
        },
        required: ["code", "name", "sampleType", "unit", "price", "loinc"],
        additionalProperties: false
      }
    },
    note: { type: "string" }
  },
  required: ["rows", "note"],
  additionalProperties: false
};

export async function draftTests(text: string, existing: Existing[]): Promise<DraftResult> {
  if (!aiEnabled()) return { ...draftByRules(text, existing), note: "AI is off (no ANTHROPIC_API_KEY), so the list was split by simple rules." };
  try {
    const out = await askJson<{ rows: DraftRow[]; note: string }>(
      "You turn a lab's list of diagnostic tests into catalog rows for a lab-integration product. " +
      "For each test the user lists, give: a short uppercase code (2-30 chars, letters, digits or hyphens, " +
      "the common abbreviation where one exists, e.g. CBC, TSH, HBA1C, LIPID), a clear full name, the usual sample type " +
      "(e.g. Blood, Serum, Urine), the usual result unit or an empty string for panels, the price the user gave (0 if none), " +
      "and the LOINC code only when you are confident of it, otherwise an empty string. Keep the user's order. " +
      "Do not add tests the user did not list. Codes must not repeat. If a listed test is the same investigation as one of the " +
      "existing catalog tests, use that test's existing code (saving will update it); otherwise use a code not in the catalog. " +
      "In `note`, mention anything the user should check (unclear names, missing prices).",
      `Existing catalog tests: ${JSON.stringify(existing)}\n\nTests:\n${text}`,
      draftSchema
    );
    const taken = new Set<string>();
    const rows = out.rows.map(r => {
      let code = (r.code || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 30);
      if (!CODE_RE.test(code) || taken.has(code)) code = codeFromName(r.name, taken); else taken.add(code);
      return {
        code, name: r.name.slice(0, 120), price: Math.max(0, Number(r.price) || 0),
        sampleType: r.sampleType || undefined, unit: r.unit || undefined, loinc: r.loinc || undefined
      };
    });
    return { rows, source: "ai", note: out.note || undefined };
  } catch (error) {
    return { ...draftByRules(text, existing), note: `Claude was not used (${aiError(error)}), so the list was split by simple rules.` };
  }
}

// ---------- 2. Match Healjour tests to Flabs tests ----------

export type FlabsListItem = { _id: string; name: string; code: string; cost: number };
export type MatchSuggestion = {
  healjourCode: string; healjourName: string;
  flabsId: string | null; flabsName: string | null; flabsCode: string | null; flabsCost: number | null;
  confidence: "high" | "medium" | "low" | "none"; reason: string;
};
export type MatchResult = { suggestions: MatchSuggestion[]; source: "ai" | "rules"; note?: string };

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 2);

function matchByRules(healjour: Array<{ code: string; name: string }>, flabs: FlabsListItem[]): MatchResult {
  const suggestions = healjour.map(t => {
    const want = new Set(words(t.name));
    let best: { f: FlabsListItem; score: number; why: string } | null = null;
    for (const f of flabs) {
      const sameCode = Boolean(f.code) && f.code.toUpperCase() === t.code.toUpperCase();
      const overlap = words(f.name).filter(w => want.has(w)).length;
      const score = (sameCode ? 10 : 0) + overlap;
      if (score > 0 && (!best || score > best.score)) {
        best = { f, score, why: sameCode ? `Same code ${f.code}.` : `${overlap} word(s) of the name match.` };
      }
    }
    if (!best) return { healjourCode: t.code, healjourName: t.name, flabsId: null, flabsName: null, flabsCode: null, flabsCost: null, confidence: "none" as const, reason: "No Flabs test with this code or a similar name." };
    const confidence = best.score >= 10 ? "high" as const : best.score >= 2 ? "medium" as const : "low" as const;
    return { healjourCode: t.code, healjourName: t.name, flabsId: best.f._id, flabsName: best.f.name, flabsCode: best.f.code, flabsCost: best.f.cost, confidence, reason: best.why };
  });
  return { suggestions, source: "rules" };
}

const matchSchema = {
  type: "object",
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          healjourCode: { type: "string" },
          flabsId: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low", "none"] },
          reason: { type: "string" }
        },
        required: ["healjourCode", "flabsId", "confidence", "reason"],
        additionalProperties: false
      }
    }
  },
  required: ["matches"],
  additionalProperties: false
};

export async function suggestMatches(healjour: Array<{ code: string; name: string }>, flabs: FlabsListItem[]): Promise<MatchResult> {
  if (!healjour.length) return { suggestions: [], source: aiEnabled() ? "ai" : "rules" };
  if (!aiEnabled()) return { ...matchByRules(healjour, flabs), note: "AI is off (no ANTHROPIC_API_KEY), so matches come from codes and name words." };
  try {
    const out = await askJson<{ matches: Array<{ healjourCode: string; flabsId: string; confidence: MatchSuggestion["confidence"]; reason: string }> }>(
      "You match a lab-integration product's test catalog to the test list of one lab's billing system (Flabs). " +
      "For every Healjour test, pick the single Flabs test that is the same investigation, judging by code, name, " +
      "abbreviations and synonyms (e.g. 'Complete Blood Count' = 'CBC' = 'Hemogram'; 'HbA1c' = 'Glycated Haemoglobin'). " +
      "Use only `_id` values from the Flabs list. If none is the same test, return an empty flabsId and confidence 'none'. " +
      "'high' means certainly the same test; 'medium' likely; 'low' a guess staff must check. " +
      "Panels and single analytes are different tests. Give a one-sentence reason. Return one entry per Healjour test.",
      `Healjour tests:\n${JSON.stringify(healjour)}\n\nFlabs tests:\n${JSON.stringify(flabs.map(f => ({ _id: f._id, name: f.name, code: f.code })))}`,
      matchSchema
    );
    const byId = new Map(flabs.map(f => [f._id, f]));
    const byCode = new Map(out.matches.map(m => [m.healjourCode, m]));
    const suggestions = healjour.map(t => {
      const m = byCode.get(t.code);
      const f = m?.flabsId ? byId.get(m.flabsId) : undefined; // an ID not in the list is dropped, never guessed
      if (!m || !f) return { healjourCode: t.code, healjourName: t.name, flabsId: null, flabsName: null, flabsCode: null, flabsCost: null, confidence: "none" as const, reason: m?.reason || "No matching Flabs test." };
      return { healjourCode: t.code, healjourName: t.name, flabsId: f._id, flabsName: f.name, flabsCode: f.code, flabsCost: f.cost, confidence: m.confidence, reason: m.reason };
    });
    return { suggestions, source: "ai" };
  } catch (error) {
    return { ...matchByRules(healjour, flabs), note: `Claude was not used (${aiError(error)}), so matches come from codes and name words.` };
  }
}
