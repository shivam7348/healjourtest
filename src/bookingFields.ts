// Patient-detail fields of the Flabs booking form. Admins can show/hide, require, rename, reorder
// and add their own fields from "Form settings". Built-in keys map to fixed Flabs API fields.

export type FieldType = "text" | "number" | "date" | "datetime" | "select" | "textarea";

export type FieldConfig = {
  key: string;
  label: string;
  type: FieldType;
  visible: boolean;
  required: boolean;
  options?: string[];   // for select fields
  custom?: boolean;     // added by the admin; its value is sent in Flabs customFields
  defaultValue?: string; // pre-filled in the booking form; staff can still change it
};

/** These are always shown and required: the Flabs lead cannot be created without them. */
export const LOCKED_FIELDS = ["first_name", "contact", "age"];

export const DEFAULT_FIELDS: FieldConfig[] = [
  { key: "first_name", label: "First name", type: "text", visible: true, required: true },
  { key: "last_name", label: "Last name", type: "text", visible: true, required: false },
  { key: "designation", label: "Designation", type: "text", visible: true, required: false },
  { key: "contact", label: "Mobile number", type: "text", visible: true, required: true },
  { key: "email", label: "Email", type: "text", visible: true, required: false },
  { key: "scheduledAt", label: "Booking date", type: "datetime", visible: true, required: false },
  { key: "bookingType", label: "Collection type", type: "select", visible: true, required: false, options: ["Home Collection", "Lab Visit"] },
  { key: "age", label: "Age", type: "number", visible: true, required: true },
  { key: "age_type", label: "Age type", type: "select", visible: true, required: true, options: ["year", "month", "day"] },
  { key: "gender", label: "Gender", type: "select", visible: true, required: false, options: ["male", "female", "other"] },
  { key: "weight", label: "Weight (kg)", type: "number", visible: true, required: false },
  { key: "height", label: "Height (cm)", type: "number", visible: true, required: false },
  { key: "address", label: "Address", type: "text", visible: true, required: false },
  { key: "pincode", label: "Pincode", type: "text", visible: true, required: false },
  { key: "googleLocation", label: "Google location", type: "text", visible: true, required: false },
  { key: "aadhaar_number", label: "Aadhaar number", type: "text", visible: true, required: false },
  { key: "insurance_number", label: "Insurance number", type: "text", visible: true, required: false },
  { key: "uhid", label: "UHID", type: "text", visible: true, required: false },
  { key: "passport_number", label: "Passport number", type: "text", visible: true, required: false },
  { key: "owner_name", label: "Owner name (pets)", type: "text", visible: true, required: false },
  { key: "breed", label: "Breed (pets)", type: "text", visible: true, required: false },
  { key: "category", label: "Category (pets)", type: "text", visible: true, required: false }
];

/** Makes sure locked fields stay visible and required, and removes unknown or duplicate entries. */
export function normalizeFields(list: FieldConfig[] | undefined): FieldConfig[] {
  const src = Array.isArray(list) && list.length ? list : DEFAULT_FIELDS;
  const seen = new Set<string>();
  const out: FieldConfig[] = [];
  for (const f of src) {
    if (!f || !f.key || seen.has(f.key)) continue;
    seen.add(f.key);
    const locked = LOCKED_FIELDS.includes(f.key);
    out.push({ ...f, visible: locked ? true : Boolean(f.visible), required: locked ? true : Boolean(f.required) });
  }
  // Built-in fields added in a later version are appended; locked ones go first.
  for (const d of DEFAULT_FIELDS) {
    if (seen.has(d.key)) continue;
    if (LOCKED_FIELDS.includes(d.key)) out.unshift(d);
    else out.push(d);
  }
  return out;
}

/** Settings screen sections. Fields not listed here (custom ones) go under "Additional information". */
export const FIELD_SECTIONS: Array<{ id: string; title: string; hint: string; keys: string[] }> = [
  { id: "patient", title: "Patient details", hint: "Who the booking is for.", keys: ["first_name", "last_name", "designation", "contact", "email", "age", "age_type", "gender", "weight", "height"] },
  { id: "schedule", title: "Schedule & Collection", hint: "Bookings only. The New Lead form has no schedule.", keys: ["scheduledAt", "bookingType"] },
  { id: "address", title: "Address & location", hint: "Where the sample is collected.", keys: ["address", "pincode", "googleLocation"] },
  { id: "ids", title: "IDs & insurance", hint: "Government, hospital and insurance identifiers.", keys: ["aadhaar_number", "insurance_number", "uhid", "passport_number"] },
  { id: "pets", title: "Pet details", hint: "For veterinary bookings.", keys: ["owner_name", "breed", "category"] },
  { id: "custom", title: "Additional information", hint: "Your own fields. Their values go to Flabs as customFields.", keys: [] }
];
export const sectionOf = (key: string) => FIELD_SECTIONS.find(s => s.keys.includes(key))?.id ?? "custom";

/** Fields that only apply to bookings (not leads). */
export const BOOKING_ONLY = ["scheduledAt", "bookingType"];

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * A relative date default: "today+N" or "today+N@HH:MM" (N may be 0). Worked out each time the form opens.
 * Returns null when the value is not a relative default.
 */
export function parseRelative(value?: string): { days: number; time: string } | null {
  const m = /^today(?:\+(\d{1,3}))?(?:@(\d{2}:\d{2}))?$/.exec((value ?? "").trim());
  return m ? { days: Number(m[1] ?? 0), time: m[2] ?? "" } : null;
}
export const relativeValue = (days: number | null, time: string) =>
  days === null ? (time ? `today@${time}` : "") : `today${days ? `+${days}` : ""}${time ? `@${time}` : ""}`;

/** The date a relative default opens on, from today. */
export function relativeDate(days: number, from = new Date()): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d;
}

/** The value a field starts with in the booking form (relative dates turned into real ones). */
export function resolveDefault(fc: FieldConfig, now = new Date()): string {
  const raw = fc.defaultValue ?? "";
  const rel = parseRelative(raw);
  if (!rel) return raw;
  const day = ymd(relativeDate(rel.days, now));
  if (fc.type === "date") return day;
  if (fc.type === "datetime") return `${day}T${rel.time}`;
  return "";
}
