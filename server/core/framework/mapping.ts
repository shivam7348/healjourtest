// Declarative field mapping: turns a partner's (often messy) record into the shape another system expects.
// A spec is a list of rules; each rule reads one source path, cleans it with transforms, and writes one target path.
//
//   { to: "patient.mobile", from: "contact", transform: "phone10", required: true }
//   { to: "gender", from: "sex", transform: ["trim", "gender"], default: "other" }
//   { to: "source", const: "healjour" }

export type Transform =
  | "trim" | "upper" | "lower" | "number" | "string" | "boolean"
  | "phone10" | "isoDate" | "gender" | "split" | "join"
  | `prefix:${string}` | `map:${string}`;

export type FieldRule = {
  to: string;
  from?: string;
  const?: unknown;
  default?: unknown;
  required?: boolean;
  transform?: Transform | Transform[];
};

export type MappingSpec = { name?: string; version?: string; rules: FieldRule[] };
export type MappingResult = { output: Record<string, unknown>; errors: string[]; warnings: string[] };

/** Reads "a.b[0].c" from an object. */
export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur: any = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Writes "a.b[0].c" into an object, creating objects and arrays on the way. */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur: any = obj;
  parts.forEach((p, i) => {
    if (i === parts.length - 1) { cur[p] = value; return; }
    if (cur[p] === undefined || cur[p] === null) cur[p] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    cur = cur[p];
  });
}

const empty = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** Accepts 2026-11-17, 17-11-2026, 17/11/2026 and full ISO times; returns YYYY-MM-DD. */
function toIsoDate(v: string): string | null {
  const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

function applyTransform(t: Transform, value: unknown, field: string): { value: unknown; error?: string } {
  if (empty(value) && t !== "boolean") return { value };
  const s = String(value);
  switch (t) {
    case "trim": return { value: s.trim().replace(/\s+/g, " ") };
    case "upper": return { value: s.toUpperCase() };
    case "lower": return { value: s.toLowerCase() };
    case "string": return { value: s };
    case "number": {
      const n = Number(s.replace(/,/g, ""));
      return Number.isFinite(n) ? { value: n } : { value, error: `${field}: "${s}" is not a number` };
    }
    case "boolean": return { value: ["true", "1", "yes", "y"].includes(s.trim().toLowerCase()) };
    case "phone10": {
      const digits = s.replace(/\D/g, "");
      const ten = digits.length > 10 ? digits.slice(-10) : digits;
      return ten.length === 10 ? { value: ten } : { value, error: `${field}: "${s}" is not a 10-digit mobile number` };
    }
    case "isoDate": {
      const d = toIsoDate(s);
      return d ? { value: d } : { value, error: `${field}: "${s}" is not a date this mapper understands` };
    }
    case "gender": {
      const g = s.trim().toLowerCase();
      if (["m", "male", "man"].includes(g)) return { value: "male" };
      if (["f", "female", "woman"].includes(g)) return { value: "female" };
      if (["o", "other", "others"].includes(g)) return { value: "other" };
      return { value, error: `${field}: "${s}" is not a known gender` };
    }
    case "split": return { value: s.split(",").map(x => x.trim()).filter(Boolean) };
    case "join": return { value: Array.isArray(value) ? value.join(", ") : s };
    default: {
      if (t.startsWith("prefix:")) return { value: `${t.slice(7)}${s}` };
      if (t.startsWith("map:")) {
        try {
          const table = JSON.parse(t.slice(4)) as Record<string, unknown>;
          const key = Object.keys(table).find(k => k.toLowerCase() === s.trim().toLowerCase());
          return key !== undefined ? { value: table[key] } : { value, error: `${field}: "${s}" has no entry in the value map` };
        } catch {
          return { value, error: `${field}: the value map is not valid JSON` };
        }
      }
      return { value, error: `${field}: unknown transform "${t}"` };
    }
  }
}

/** Applies a mapping spec to one input record. Never throws; problems come back as errors/warnings. */
export function mapEntity(spec: MappingSpec, input: unknown): MappingResult {
  const output: Record<string, unknown> = {};
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const rule of spec.rules ?? []) {
    let value: unknown = rule.const !== undefined ? rule.const : rule.from !== undefined ? getPath(input, rule.from) : undefined;
    const transforms = rule.transform ? (Array.isArray(rule.transform) ? rule.transform : [rule.transform]) : [];
    for (const t of transforms) {
      const r = applyTransform(t, value, rule.to);
      if (r.error) { errors.push(r.error); break; }
      value = r.value;
    }
    if (empty(value) && rule.default !== undefined) {
      value = rule.default;
      if (rule.from) warnings.push(`${rule.to}: empty in the source, default used`);
    }
    if (empty(value)) {
      if (rule.required) errors.push(`${rule.to}: required${rule.from ? ` (from ${rule.from})` : ""} but empty`);
      continue;
    }
    setPath(output, rule.to, value);
  }
  return { output, errors, warnings };
}
