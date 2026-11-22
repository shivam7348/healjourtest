// Offline check of Flabs sync auto-create + categories. Uses the memory store and a fake Flabs API.
// Run: npx tsx scripts/test-catalog-categories.ts
process.env.MONGODB_URI = "mongodb://127.0.0.1:1";
process.env.MONGODB_TIMEOUT_MS = "300";

import { categorize, toCatalogCode, uniqueCode } from "../server/core/catalog-category.js";
import { connectStore, getStore } from "../server/core/store.js";
import { syncFlabsCatalog } from "../server/core/flabs/sink.js";
import type { FlabsConfig } from "../server/core/flabs/client.js";

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, extra = "") => { if (ok) pass++; else fail++; console.log(`${ok ? "PASS" : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`); };

const cases: Array<[string, string, string]> = [
  ["CBC (Complete Blood Count)", "Pathology", "Haematology"],
  ["BT CT (Bleeding time clotting time)", "Pathology", "Haematology"],
  ["Lipid Profile", "Pathology", "Biochemistry"],
  [" Vitamin D3", "Pathology", "Biochemistry"],
  ["Thyroid Profile (T3 T4 TSH)", "Pathology", "Endocrinology"],
  ["Urine Routine & Microscopy", "Pathology", "Clinical Pathology"],
  ["Urine Culture & Sensitivity", "Pathology", "Microbiology"],
  ["Widal Test", "Pathology", "Serology & Immunology"],
  ["HIV I & II Antibody", "Pathology", "Serology & Immunology"],
  ["Bilirubin Direct", "Pathology", "Biochemistry"],
  ["COVID RT-PCR", "Pathology", "Molecular"],
  ["Pap Smear", "Pathology", "Histopathology & Cytology"],
  ["USG OF BOTH LOWER LIMBS PERFORMED", "Radiology", "Ultrasound"],
  ["USG Whole Abdomen", "Radiology", "Ultrasound"],
  ["Colour Doppler Both Lower Limbs", "Radiology", "Doppler"],
  ["X-Ray Chest PA View", "Radiology", "X-Ray"],
  ["XRAY KNEE AP/LAT", "Radiology", "X-Ray"],
  ["CT Scan Brain (NCCT)", "Radiology", "CT Scan"],
  ["HRCT Chest", "Radiology", "CT Scan"],
  ["MRI Lumbar Spine", "Radiology", "MRI"],
  ["Mammography Bilateral", "Radiology", "Mammography"],
  ["ECG", "Cardiology", "ECG"],
  ["2D Echo", "Cardiology", "Echo"],
  ["TMT (Treadmill Test)", "Cardiology", "TMT"],
  ["EEG", "Neurology", "EEG"],
  ["PFT", "Pulmonology", "PFT & Spirometry"],
  ["Doctor Consultation", "Other", "General"],
  ["Some unknown thing", "Pathology", "General"]
];
for (const [name, cat, sub] of cases) {
  const g = categorize(name);
  check(`categorize "${name}"`, g.category === cat && g.subcategory === sub, `${g.category} / ${g.subcategory}`);
}
check("toCatalogCode trims and cleans", toCatalogCode(" vit d3 ", "Vitamin D3") === "VIT-D3", toCatalogCode(" vit d3 ", "Vitamin D3"));
check("toCatalogCode falls back to name", toCatalogCode("", "Lipid Profile") === "LIPID-PROFILE");
check("toCatalogCode max 30", toCatalogCode("", "USG OF BOTH LOWER LIMBS PERFORMED WITH COLOUR").length <= 30);
check("uniqueCode suffix", uniqueCode("CBC", new Set(["CBC", "CBC-2"])) === "CBC-3");

// Fake Flabs: login + tests + packages.
const flabsTests = [
  { _id: "f1", code: "CBC", name: "Complete Blood Count", cost: 300 },          // exists in Healjour: matched, untouched
  { _id: "f2", code: " VITD3", name: " Vitamin D3", cost: 1200 },              // new
  { _id: "f3", code: "USG-LL", name: "USG OF BOTH LOWER LIMBS PERFORMED", cost: 900 }, // new, radiology
  { _id: "f4", code: "ECG", name: "ECG", cost: 250 },                          // new, cardiology
  { _id: "f5", code: "", name: "X-Ray Chest PA View", cost: 400 }               // new, code from name
];
(globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  if (url.includes("/client/auth/token")) return json({ authToken: "t", refreshToken: "r", expiresIn: 600 });
  if (url.includes("/client/crm/tests")) return json({ tests: flabsTests });
  if (url.includes("/client/crm/packages")) return json({ packages: [] });
  return json({});
}) as typeof fetch;

(async () => {
  await connectStore();
  const store = getStore();
  check("memory store", store.kind === "memory");
  const before = await store.listCatalogTests();
  const cbcBefore = JSON.stringify(before.find(t => t.code === "CBC"));
  const config = { id: "acc1", label: "Test account", baseUrl: "https://flabs.invalid", clientId: "x", clientSecret: "y", branchId: "b1" } as unknown as FlabsConfig;

  const r1 = await syncFlabsCatalog(config);
  const after = await store.listCatalogTests();
  check("created 4 new tests", r1.created.length === 4, r1.created.map(c => `${c.code}:${c.category}`).join(", "));
  check("existing CBC untouched", JSON.stringify(after.find(t => t.code === "CBC")) === cbcBefore);
  const vit = after.find(t => t.code === "VITD3");
  check("VITD3 name/price/category", vit?.name === "Vitamin D3" && vit.price === 1200 && vit.category === "Pathology", JSON.stringify(vit));
  check("USG-LL is Radiology", after.find(t => t.code === "USG-LL")?.category === "Radiology");
  check("ECG is Cardiology", after.find(t => t.code === "ECG")?.category === "Cardiology");
  check("X-ray code from name", after.some(t => t.code === "X-RAY-CHEST-PA-VIEW" && t.subcategory === "X-Ray"));
  check("all Flabs tests mapped", r1.flabsOnly.length === 0 && r1.matched.length >= 5, `flabsOnly=${r1.flabsOnly.join(",")}`);

  // Manual change survives a re-sync, and a re-sync creates nothing new.
  await store.saveCatalogTest({ ...after.find(t => t.code === "ECG")!, category: "Other", categorySource: "manual" });
  const r2 = await syncFlabsCatalog(config);
  check("second sync creates nothing", r2.created.length === 0, String(r2.created.length));
  check("manual category kept", (await store.listCatalogTests()).find(t => t.code === "ECG")?.category === "Other");

  // Same code with a different Flabs test on another account goes to a free code and keeps mapping on re-sync.
  flabsTests.push({ _id: "g1", code: "ECG", name: "ECG Report Only", cost: 100 });
  const r3 = await syncFlabsCatalog(config);
  check("duplicate code gets suffix", r3.created.length === 1 && r3.created[0].code === "ECG-2", JSON.stringify(r3.created));
  const r4 = await syncFlabsCatalog(config);
  check("suffixed test is not created again", r4.created.length === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
