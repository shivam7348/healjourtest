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
  { key: "scheduledAt", label: "Scheduled date & time", type: "datetime", visible: true, required: false },
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
