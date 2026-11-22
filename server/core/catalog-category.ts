// Test categories for the Healjour catalog: Pathology, Radiology, Cardiology, ...
// Flabs sends only name + code + cost, so the category is worked out from the name and code.
// A category set by hand (categorySource "manual") is never replaced by detection.

import type { CatalogTest } from "./models.js";

export const CATEGORIES = ["Pathology", "Radiology", "Cardiology", "Neurology", "Pulmonology", "Other"] as const;

export const SUBCATEGORIES: Record<string, string[]> = {
  Pathology: ["Haematology", "Biochemistry", "Endocrinology", "Serology & Immunology", "Microbiology", "Clinical Pathology", "Histopathology & Cytology", "Molecular", "General"],
  Radiology: ["X-Ray", "Ultrasound", "Doppler", "CT Scan", "MRI", "Mammography", "Other imaging"],
  Cardiology: ["ECG", "Echo", "TMT", "Holter & BP monitoring"],
  Neurology: ["EEG", "Nerve conduction & EMG"],
  Pulmonology: ["PFT & Spirometry"],
  Other: ["General", "Procedures"]
};

type Rule = { category: string; subcategory: string; pattern: RegExp };

// Order matters: the first rule that matches wins.
const RULES: Rule[] = [
  // Pathology terms that would otherwise look like imaging or cardiology (e.g. "BT CT", "CT value").
  { category: "Pathology", subcategory: "Haematology", pattern: /\b(BLEEDING|CLOTTING)\b|\bBT\s*[\/&,-]?\s*CT\b/ },
  { category: "Pathology", subcategory: "Molecular", pattern: /\b(RT[\s-]?PCR|PCR|CBNAAT|TRUENAT|GENE ?XPERT|GENOTYP\w*|VIRAL LOAD|DNA|RNA|MUTATION|KARYOTYP\w*|FISH|NGS|SEQUENCING)\b/ },

  // Radiology.
  { category: "Radiology", subcategory: "Doppler", pattern: /\b(DOPPLER|DUPLEX)\b/ },
  { category: "Radiology", subcategory: "Mammography", pattern: /\bMAMMO\w*/ },
  { category: "Radiology", subcategory: "MRI", pattern: /\b(MRI|MRA|MRV|MRCP|MR ANGIO\w*)\b/ },
  { category: "Radiology", subcategory: "CT Scan", pattern: /\b(CT|HRCT|CECT|NCCT|CTA|CT ?SCAN|CT ?ANGIO\w*|PET[\s-]?CT)\b/ },
  { category: "Radiology", subcategory: "Ultrasound", pattern: /\b(USG|ULTRASOUND|ULTRASONOGRAPHY|SONOGRAPHY|SONO|TVS|NT ?SCAN|ANOMALY SCAN|FOLLICULAR (STUDY|MONITORING)|OBSTETRIC|ABDOMEN (AND|&) PELVIS)\b/ },
  { category: "Radiology", subcategory: "X-Ray", pattern: /\b(X[\s-]?RAY|XRAY|SKIAGRAM|RADIOGRAPH\w*|OPG|IVP|IVU|HSG|BARIUM|FLUOROSCOPY|MCU|RGU|\w*CYSTOGRAPHY|\w*URETHROGRAPHY|\w*PYELOGRAPHY)\b|\b(AP|PA|LAT(ERAL)?|OBLIQUE)\b.*\bVIEWS?\b/ },
  { category: "Radiology", subcategory: "Other imaging", pattern: /\b(DEXA|BMD|BONE DENSITOMETRY|PET SCAN|SCINTIGRAPHY|NUCLEAR SCAN)\b/ },

  // Cardiology.
  { category: "Cardiology", subcategory: "Echo", pattern: /\b(2D[\s-]?ECHO|ECHO\w*|ECHOCARDIOGRAPHY)\b/ },
  { category: "Cardiology", subcategory: "TMT", pattern: /\b(TMT|TREADMILL|STRESS TEST)\b/ },
  { category: "Cardiology", subcategory: "Holter & BP monitoring", pattern: /\b(HOLTER|ABPM|AMBULATORY BP)\b/ },
  { category: "Cardiology", subcategory: "ECG", pattern: /\b(ECG|EKG|ELECTROCARDIOGRA\w*)\b/ },

  // Neurology and Pulmonology.
  { category: "Neurology", subcategory: "EEG", pattern: /\b(EEG|ELECTROENCEPHALOGRA\w*)\b/ },
  { category: "Neurology", subcategory: "Nerve conduction & EMG", pattern: /\b(NCV|NCS|EMG|NERVE CONDUCTION|VEP|BERA|SSEP)\b/ },
  { category: "Pulmonology", subcategory: "PFT & Spirometry", pattern: /\b(PFT|SPIROMETRY|PULMONARY FUNCTION|DLCO)\b/ },

  // Non-test items.
  { category: "Other", subcategory: "Procedures", pattern: /\b(ENDOSCOPY|COLONOSCOPY|GASTROSCOPY|BRONCHOSCOPY|CYSTOSCOPY|LARYNGOSCOPY|PROCEDURE|BLOOD BAG|SERUM SEPARATION|TRANSFUSION)\b/ },
  { category: "Other", subcategory: "General", pattern: /\b(CONSULTATION|CONSULT|HOME COLLECTION|COLLECTION CHARGES?|VISIT CHARGES?|REGISTRATION)\b/ },

  // Pathology sections.
  { category: "Pathology", subcategory: "Histopathology & Cytology", pattern: /\bBIOPS\w*|\b(HISTOPATH\w*|HPE|FNAC|CYTOLOGY|PAP ?SMEAR|LBC|FROZEN SECTION|IHC|IMMUNOHISTO\w*|SPECIAL STAIN|TRICHROME|CONGO RED|CRYSTAL VIOLET|PAS STAIN|RETICULIN|NAPSIN\w*|KI[\s-]?67|CELL MORPHOLOGY|SLIDE REVIEW)\b/ },
  { category: "Pathology", subcategory: "Microbiology", pattern: /\b(CULTURE|C\s*\/\s*S|SENSITIVITY|GRAM ?STAIN|AFB|ZN ?STAIN|KOH|INDIA INK|FUNGAL|FUNGUS|SCRAPING|EAR WAX|DRY STAIN|SWAB|COCCIDI\w*|MITES?)\b/ },
  { category: "Pathology", subcategory: "Clinical Pathology", pattern: /\b(URINE|URINALYSIS|STOOL|FAECAL|FECAL|SEMEN|SPUTUM|CSF|FLUID|OCCULT|R\s*\/\s*M|ROUTINE (AND|&) MICRO\w*|PREGNANCY TEST|UPT|STONE ANALYSIS|CALCULUS|BILE PIGMENTS?|BILE SALTS?|KETONES?|MICROALBUMIN\w*)\b/ },
  { category: "Pathology", subcategory: "Endocrinology", pattern: /\b(TSH|FT3|FT4|T3|T4|THYROID|LH|FSH|PROLACTIN|TESTOSTERONE|ESTRADIOL|OESTRADIOL|E2|PROGESTERONE|CORTISOL|INSULIN|C[\s-]?PEPTIDE|AMH|BETA ?HCG|B[\s-]?HCG|PTH|DHEA\w*|GROWTH HORMONE|ACTH|HORMONE|ESTROGEN|OESTROGEN|ANDROSTENEDIONE|ALDOSTERONE|RENIN|THYROGLOBULIN|THYROGOLUBIN|FGF[\s-]?23|IGF\w*|SUPPRESSION TEST|STIMULATION TEST|SYNACTHEN|LDDST|HDDST|TFT)\b/ },
  { category: "Pathology", subcategory: "Serology & Immunology", pattern: /\b(WIDAL|HIV|HBSAG|HCV|HAV|HEV|VDRL|RPR|TPHA|DENGUE|MALARIA|TYPHI\w*|TYPHOID|CHIKUNGUNYA|LEPTOSPIRA|SCRUB|CRP|HS[\s-]?CRP|RA FACTOR|RHEUMATOID|ASO|ANA|ANCA|DSDNA|IGG|IGM|IGA|IGE|ANTIBOD\w*|ANTIGEN|TORCH|COOMBS|ALLERG\w*|COVID|TB GOLD|QUANTIFERON|MANTOUX|ANTI[\s-]\w+|AB TEST|AG TEST|KIT TEST|RAPID|ELISA|PANLEUKOPENIA|PARVO\w*|DISTEMPER|BRUCELL\w*|LEPTO\w*|EHRLICHIA|BABESIA|FIV|FELV|FIP|TOXOPLASM\w*|TUBERCULOSIS|TB|CALI?CIVIRUS|NDV|SNAP\w*|DIROFILARIA|HEARTWORM|MICROFILARIA|RUBELLA|CMV|HSV|HERPES|MEASLES|MUMPS|H\.? ?PYLORI)\b/ },
  { category: "Pathology", subcategory: "Haematology", pattern: /\b(CBC|HAEMOGRAM|HEMOGRAM|HB|HGB|HAEMOGLOBIN|HEMOGLOBIN|ESR|PLATELETS?|TLC|DLC|PCV|HCT|RETIC\w*|PERIPHERAL SMEAR|PS FOR|SMEAR EXAMINATION|BLOOD PARASITES?|HA?EMOPARASIT\w*|BLOOD GROUP\w*|RH TYPING|PT|APTT|INR|PROTHROMBIN|D[\s-]?DIMER|FIBRINOGEN|COAGULATION|G6PD|SICKLING|HB ?ELECTROPHORESIS|AEC|EOSINOPHIL\w*|RBC|WBC|LEUKOCYTES?|ERYTHROCYTES?|RED BLOOD CELLS?|WHITE BLOOD CELLS?|BLOOD SMEAR|BLOOD PROTOZOA|MP|MALARIAL PARASITE)\b/ },
  { category: "Pathology", subcategory: "Biochemistry", pattern: /\b(GLUCOSE|SUGAR|FBS|PPBS|RBS|HBA1C|GTT|LFT|KFT|RFT|LIPID|CHOLESTEROL|TRIGLYCERIDES?|HDL|LDL|VLDL|UREA|BUN|CREATININE|URIC ACID|BILIRUBIN|SGOT|SGPT|AST|ALT|ALP|GGT|ALBUMIN|PROTEINS?|GLOBULIN|KIDNEY FUNCTION|LIVER FUNCTION|RENAL FUNCTION|GFR|BLOOD PH|ELECTROLYTES?|SODIUM|POTASSIUM|CHLORIDE|CALCIUM|PHOSPHORUS|MAGNESIUM|IRON|TIBC|FERRITIN|TRANSFERRIN|VITAMIN|VIT|B12|FOLATE|FOLIC|AMYLASE|LIPASE|LDH|CPK|CK[\s-]?MB|TROPONIN|BNP|HOMOCYSTEINE|LACTATE|AMMONIA|ABG|PSA|CEA|AFP|CA[\s-]?125|CA[\s-]?19|CA[\s-]?15|TUMOU?R MARKER|PROFILE|PANEL|ZINC|COPPER|PHOSPHATASE|BICARBONATE|CO2|BILE ACIDS?|FRUCTOSAMINE|MYOGLOBIN|CYSTATIN\w*|MICROGLOBULIN|PROCALCITONIN|LIPOPROTEIN\w*|APOLIPOPROTEIN\w*|SDMA|CHEMISTRY|DRUG LEVEL|PHENOBARB\w*|VALPRO\w*|DIGOXIN|LITHIUM|PHENYTOIN|CARBAMAZEPINE|TACROLIMUS|CREATINE|GLYCATED|OSMOLALITY|LEAD|MERCURY|ARSENIC|SELENIUM|ELECTROPHORESIS)\b|\bNT[\s-]?PRO\w*|\bPRO[\s-]?BNP/ }
];

export type CategoryGuess = { category: string; subcategory: string };

/** Best guess of category and subcategory from a test's name and code. Defaults to Pathology / General. */
export function categorize(name: string, code = ""): CategoryGuess {
  const text = ` ${name} ${code} `.toUpperCase().replace(/\s+/g, " ");
  for (const rule of RULES) if (rule.pattern.test(text)) return { category: rule.category, subcategory: rule.subcategory };
  return { category: "Pathology", subcategory: "General" };
}

/** The test as the UI sees it. Auto categories are worked out on every read, so better rules reach every test not set by hand. */
export function withCategory(test: CatalogTest): CatalogTest & { category: string; subcategory: string; categorySource: "auto" | "manual" } {
  if (test.category && test.categorySource === "manual") {
    return { ...test, category: test.category, subcategory: test.subcategory ?? "", categorySource: "manual" };
  }
  return { ...test, ...categorize(test.name, test.code), categorySource: "auto" };
}

/**
 * Turns a Flabs code (which may have spaces, dots or slashes) into a Healjour catalog code:
 * 2-30 characters, uppercase letters, digits and hyphens. Falls back to the name when the code is unusable.
 */
export function toCatalogCode(code: string, name: string): string {
  const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/g, "");
  const fromCode = clean(code ?? "");
  if (fromCode.length >= 2) return fromCode;
  const fromName = clean(name ?? "");
  return fromName.length >= 2 ? fromName : `T-${fromName || "X"}`;
}

/** A code that is not in `taken`: CODE, CODE-2, CODE-3 ... kept within 30 characters. */
export function uniqueCode(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 30 - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`No free code for ${base}.`);
}
