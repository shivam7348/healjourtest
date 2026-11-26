// Single source for the Healjour developer documentation: the /developers website renders it and
// GET /api/v1/openapi.json is generated from it, so the docs and the spec never drift apart.

export type Method = "GET" | "POST" | "PUT" | "DELETE";
export type AppType = "partner" | "lab";
export type Param = { name: string; in: "path" | "query" | "body"; type: string; required?: boolean; description: string; example?: unknown };
export type ResponseDoc = { status: number; description: string; example: unknown };
export type Endpoint = {
  slug: string; group: string; title: string; method: Method; path: string; summary: string;
  description?: string[]; auth: "none" | "bearer"; appTypes: AppType[];
  params: Param[]; body?: Record<string, unknown>; responses: ResponseDoc[]; binary?: boolean;
};
export type Block =
  | { t: "p"; text: string } | { t: "h"; text: string } | { t: "list"; items: string[] } | { t: "steps"; items: Array<{ title: string; text: string }> }
  | { t: "code"; lang: string; code: string } | { t: "note"; tone: "info" | "warn"; text: string }
  | { t: "cards"; items: Array<{ title: string; text: string; href: string }> } | { t: "table"; head: string[]; rows: string[][] };
export type Guide = { slug: string; group: string; title: string; summary: string; blocks: Block[] };

// ---------------- shared examples ----------------
const exBooking = {
  id: "case-mx1abc-9f2e1d", bookingNo: "HJ-261126-4F2A", externalId: "CLINIC-ORDER-1001",
  lab: { id: "lab-mwh9pxsa-4dbd5a", name: "Belife Diagnostics" },
  patient: { name: "Ravi Kumar", age: 34, ageUnit: "year", gender: "male", phone: "9876543210" },
  tests: [{ code: "CBC", name: "Complete Blood Count" }, { code: "TSH", name: "Thyroid Stimulating Hormone" }],
  priority: "routine", collection: "home", scheduledAt: "2026-11-28T08:30:00+05:30", notes: "Fasting sample", status: "processing",
  results: [{ testCode: "TSH", testName: "Thyroid Stimulating Hormone", value: "2.1", unit: "µIU/mL", referenceRange: "0.4-4.0", flag: "normal" }],
  reports: [{ id: "rpt-mx1abd-1a2b3c", fileName: "ravi-kumar-report.pdf", mimeType: "application/pdf", size: 182344, uploadedAt: "2026-11-28T16:05:11.000Z" }],
  timeline: [
    { at: "2026-11-27T10:00:00.000Z", action: "Booking received via API", status: "new", note: null, by: "Clinic App (API)" },
    { at: "2026-11-27T10:20:00.000Z", action: "New → Accepted", status: "accepted", note: null, by: "Belife Diagnostics" }
  ],
  createdAt: "2026-11-27T10:00:00.000Z", updatedAt: "2026-11-28T16:05:11.000Z"
};
const err = (code: string, message: string) => ({ success: false, error: { code, message } });
const ok = (data: unknown) => ({ success: true, data });
const unauthorized: ResponseDoc = { status: 401, description: "Missing, invalid or expired access token.", example: err("invalid_token", "The access token is invalid or expired. Get a new one with your refresh token.") };
const notFound: ResponseDoc = { status: 404, description: "Not found, or not visible to your app.", example: err("booking_not_found", "No booking with this id that your app can see.") };
const bookingId: Param = { name: "id", in: "path", type: "string", required: true, description: "Booking id (id) or booking number (bookingNo).", example: "HJ-261126-4F2A" };

// ---------------- guides ----------------
export const GUIDES: Guide[] = [
  {
    slug: "introduction", group: "Get started", title: "Introduction", summary: "Build on Healjour: send diagnostic bookings, track them live and receive results and reports.",
    blocks: [
      { t: "p", text: "The Healjour API lets clinics, hospitals, aggregators, corporates, insurers and partner labs connect their software to Healjour. Create bookings, follow every status change, and receive results and report PDFs, all over a simple JSON REST API with signed webhooks." },
      { t: "cards", items: [
        { title: "Quickstart", text: "Make your first booking in 5 minutes.", href: "quickstart" },
        { title: "Authentication", text: "Client ID + secret → access token.", href: "authentication" },
        { title: "Bookings", text: "Create and track bookings.", href: "create-booking" },
        { title: "Webhooks", text: "Real-time, signed event notifications.", href: "webhooks" }
      ] },
      { t: "h", text: "Two kinds of apps" },
      { t: "table", head: ["App type", "Who creates it", "What it can do"], rows: [
        ["Partner app", "Any developer, self-serve on the developer console", "Read the test catalog and labs, create bookings, cancel them, and read status, results and reports of the bookings it created."],
        ["Lab app", "A lab admin, in the Lab Portal → API", "Read its own lab's bookings and push status updates, results and report files for them."]
      ] },
      { t: "note", tone: "info", text: "An app only ever sees its own data: a partner app sees the bookings it created, a lab app sees its own lab's bookings. Nothing else is reachable with its keys." },
      { t: "h", text: "Base URL" },
      { t: "code", lang: "text", code: "{BASE_URL}/api/v1" },
      { t: "h", text: "Conventions" },
      { t: "list", items: [
        "JSON in, JSON out (UTF-8). Dates are ISO-8601.",
        "Every response is { \"success\": true, \"data\": … } or { \"success\": false, \"error\": { \"code\", \"message\", \"details\"? } }.",
        "Every authenticated response carries X-Request-Id: quote it when you contact support.",
        "Rate limit: 120 requests per minute per app (see Errors & rate limits)."
      ] }
    ]
  },
  {
    slug: "quickstart", group: "Get started", title: "Quickstart", summary: "From sign-up to your first booking in four steps.",
    blocks: [
      { t: "steps", items: [
        { title: "Create a developer account", text: "Open the Console tab on this site, sign up with your work email, and you are in." },
        { title: "Create an app", text: "Console → New app. Copy the Client ID and Client Secret. The secret is shown only once; store it safely on your server." },
        { title: "Get an access token", text: "Exchange the credentials for a token (valid 1 hour)." },
        { title: "Create a booking", text: "Pick a lab and test codes, then POST /bookings." }
      ] },
      { t: "code", lang: "bash", code: "# 3. Get an access token\ncurl -X POST {BASE_URL}/api/v1/auth/token \\\n  -H 'Content-Type: application/json' \\\n  -d '{\"clientId\":\"hjc_…\",\"clientSecret\":\"hjsk_…\"}'\n\n# 4. Find a lab and tests, then book\ncurl {BASE_URL}/api/v1/labs -H 'Authorization: Bearer <accessToken>'\ncurl '{BASE_URL}/api/v1/tests?search=thyroid' -H 'Authorization: Bearer <accessToken>'\n\ncurl -X POST {BASE_URL}/api/v1/bookings \\\n  -H 'Authorization: Bearer <accessToken>' -H 'Content-Type: application/json' \\\n  -d '{\"labId\":\"lab-…\",\"externalId\":\"ORDER-1001\",\"patient\":{\"name\":\"Ravi Kumar\",\"age\":34,\"gender\":\"male\",\"phone\":\"9876543210\"},\"tests\":[\"TSH\"]}'" },
      { t: "note", tone: "info", text: "Send an externalId (your own order number). Sending the same externalId again returns the first booking instead of creating a duplicate, so retries are safe." },
      { t: "p", text: "Next: register a webhook so Healjour tells you when the booking moves forward or the report is ready." }
    ]
  },
  {
    slug: "authentication", group: "Get started", title: "Authentication", summary: "Client credentials → short-lived access token + refresh token.",
    blocks: [
      { t: "p", text: "Every app has a Client ID (public) and a Client Secret (private). Exchange them at POST /auth/token for an access token (valid 1 hour) and a refresh token (valid 30 days, single use)." },
      { t: "code", lang: "http", code: "Authorization: Bearer hjat_…" },
      { t: "list", items: [
        "When the access token expires (401 invalid_token), call POST /auth/refresh with the refresh token. You get a new pair; the old refresh token stops working.",
        "Rotating the secret in the console ends every existing token of that app at once.",
        "Never put the Client Secret in a browser or mobile app. Call Healjour from your server."
      ] },
      { t: "note", tone: "warn", text: "Five wrong secrets for one Client ID from one address blocks it for 15 minutes." }
    ]
  },
  {
    slug: "errors", group: "Get started", title: "Errors & rate limits", summary: "One error format, clear codes, and how throttling works.",
    blocks: [
      { t: "code", lang: "json", code: JSON.stringify(err("validation_failed", "Some fields are missing or wrong."), null, 2).replace("}\n}", "},\n  \"details\": [{ \"field\": \"patient.age\", \"message\": \"Required\" }]\n}") },
      { t: "table", head: ["HTTP", "Typical codes", "Meaning"], rows: [
        ["400", "validation_failed, unknown_tests, invalid_status", "The request is wrong. details lists each field."],
        ["401", "missing_token, invalid_token, invalid_client", "Get a (new) token."],
        ["403", "wrong_app_type", "Your app type cannot call this endpoint."],
        ["404", "booking_not_found, lab_not_found", "It does not exist or your app cannot see it."],
        ["409", "invalid_transition, cannot_cancel, report_required", "The booking is not in a state that allows this."],
        ["429", "rate_limited, too_many_attempts", "Slow down; respect Retry-After."],
        ["5xx", "—", "Our side. Retry with backoff; quote X-Request-Id."]
      ] },
      { t: "h", text: "Rate limits" },
      { t: "p", text: "120 requests per minute per app. Every response has X-RateLimit-Limit and X-RateLimit-Remaining; a 429 also has Retry-After (seconds). Prefer webhooks over polling." }
    ]
  },
  {
    slug: "webhooks", group: "Get started", title: "Webhooks", summary: "Healjour pushes signed events to your HTTPS endpoint.",
    blocks: [
      { t: "p", text: "Register an https:// URL (console, Lab Portal, or POST /webhooks) and choose events. Healjour POSTs a JSON event to it within seconds of the change." },
      { t: "table", head: ["Event", "When"], rows: [
        ["booking.created", "A booking was created (by your partner app, or sent to your lab)."],
        ["booking.status_changed", "Status moved (accepted, sample_collected, processing, report_ready, completed, rejected, cancelled)."],
        ["booking.results_updated", "Results were entered or changed."],
        ["booking.report_uploaded", "A report file was uploaded."],
        ["booking.note_added", "A note was added to the timeline."]
      ] },
      { t: "code", lang: "json", code: JSON.stringify({ id: "evt_mx1abe7c2d4f1a", event: "booking.status_changed", createdAt: "2026-11-28T16:05:12.000Z", data: { booking: { id: exBooking.id, bookingNo: exBooking.bookingNo, externalId: exBooking.externalId, status: "report_ready", "…": "full booking" }, change: { action: "Processing → Report ready", status: "report_ready", note: null, by: "Belife Diagnostics" } } }, null, 2) },
      { t: "h", text: "Verify the signature" },
      { t: "p", text: "Each request has X-Healjour-Event, X-Healjour-Delivery and X-Healjour-Signature: t=<unix seconds>,v1=<hex>. v1 is HMAC-SHA256 of \"<t>.<raw body>\" with your webhook secret (shown once when you create the webhook). Reject old timestamps (older than 5 minutes)." },
      { t: "code", lang: "javascript", code: "import crypto from \"node:crypto\";\n\n// Express: app.post(\"/healjour\", express.raw({ type: \"application/json\" }), handler)\nfunction verify(rawBody, header, secret) {\n  const { t, v1 } = Object.fromEntries(header.split(\",\").map(p => p.split(\"=\")));\n  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;\n  const expected = crypto.createHmac(\"sha256\", secret).update(`${t}.${rawBody}`).digest(\"hex\");\n  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));\n}" },
      { t: "code", lang: "python", code: "import hmac, hashlib, time\n\ndef verify(raw_body: bytes, header: str, secret: str) -> bool:\n    parts = dict(p.split(\"=\", 1) for p in header.split(\",\"))\n    if abs(time.time() - int(parts[\"t\"])) > 300:\n        return False\n    expected = hmac.new(secret.encode(), f\"{parts['t']}.\".encode() + raw_body, hashlib.sha256).hexdigest()\n    return hmac.compare_digest(expected, parts[\"v1\"])" },
      { t: "h", text: "Delivery rules" },
      { t: "list", items: [
        "Answer with any 2xx within 10 seconds. Do slow work after answering.",
        "A failed delivery is retried twice: after 10 seconds and after 1 minute. Every attempt is shown in the console.",
        "Events can arrive more than once or out of order: use the event id to de-duplicate and the booking's updatedAt to order.",
        "Only public https:// URLs on port 443 are accepted; private and internal addresses are refused."
      ] }
    ]
  },
  {
    slug: "changelog", group: "Get started", title: "Changelog", summary: "What changed in the API.",
    blocks: [
      { t: "h", text: "v1.0 — 26 Nov 2026" },
      { t: "list", items: [
        "Self-serve developer console: apps, keys, webhooks, request and delivery logs.",
        "Authentication with client credentials, access + refresh tokens.",
        "Catalog: tests, packages, labs.",
        "Bookings: create (idempotent externalId), list, get, cancel.",
        "Lab apps: status updates, results, report upload.",
        "Signed webhooks with retries. OpenAPI spec at /api/v1/openapi.json."
      ] }
    ]
  }
];

// ---------------- endpoints ----------------
export const ENDPOINTS: Endpoint[] = [
  {
    slug: "auth-token", group: "Authentication", title: "Get access token", method: "POST", path: "/auth/token", auth: "none", appTypes: ["partner", "lab"],
    summary: "Exchange your Client ID and Client Secret for an access token (1 hour) and a refresh token (30 days).",
    params: [
      { name: "clientId", in: "body", type: "string", required: true, description: "Your app's Client ID.", example: "hjc_8f1c2a9b3d4e5f607182" },
      { name: "clientSecret", in: "body", type: "string", required: true, description: "Your app's Client Secret.", example: "hjsk_your-secret" }
    ],
    body: { clientId: "hjc_8f1c2a9b3d4e5f607182", clientSecret: "hjsk_your-secret" },
    responses: [
      { status: 200, description: "Tokens issued.", example: ok({ accessToken: "hjat_…", refreshToken: "hjrt_…", tokenType: "Bearer", expiresIn: 3600 }) },
      { status: 401, description: "Wrong credentials, or the app was revoked.", example: err("invalid_client", "Client ID or secret is not correct, or the app was revoked.") }
    ]
  },
  {
    slug: "auth-refresh", group: "Authentication", title: "Refresh access token", method: "POST", path: "/auth/refresh", auth: "none", appTypes: ["partner", "lab"],
    summary: "Get a new token pair with a refresh token. Each refresh token works once.",
    params: [{ name: "refreshToken", in: "body", type: "string", required: true, description: "The refresh token from the last token response.", example: "hjrt_…" }],
    body: { refreshToken: "hjrt_…" },
    responses: [
      { status: 200, description: "New tokens.", example: ok({ accessToken: "hjat_…", refreshToken: "hjrt_…", tokenType: "Bearer", expiresIn: 3600 }) },
      { status: 401, description: "Invalid, expired or already used.", example: err("invalid_token", "The refresh token is invalid, expired or already used.") }
    ]
  },
  {
    slug: "me", group: "Authentication", title: "Who am I", method: "GET", path: "/me", auth: "bearer", appTypes: ["partner", "lab"],
    summary: "The app behind the token: name, type, lab (for lab apps) and limits. Handy to test a token.",
    params: [],
    responses: [{ status: 200, description: "App details.", example: ok({ app: { clientId: "hjc_8f1c2a9b3d4e5f607182", name: "Clinic App", kind: "partner", lab: null }, rateLimitPerMinute: 120, tokenLifetimeSeconds: 3600 }) }, unauthorized]
  },
  {
    slug: "list-tests", group: "Catalog", title: "List tests", method: "GET", path: "/tests", auth: "bearer", appTypes: ["partner", "lab"],
    summary: "Healjour's test catalog with codes and prices. Use the codes when creating a booking.",
    params: [
      { name: "search", in: "query", type: "string", description: "Filter by code or name.", example: "thyroid" },
      { name: "limit", in: "query", type: "integer", description: "1-500, default 100." },
      { name: "offset", in: "query", type: "integer", description: "Skip this many, default 0." }
    ],
    responses: [{ status: 200, description: "Tests.", example: ok({ total: 1, limit: 100, offset: 0, tests: [{ code: "TSH", name: "Thyroid Stimulating Hormone", price: 350, sampleType: "Serum", category: "Pathology", loinc: "3016-3" }] }) }, unauthorized]
  },
  {
    slug: "list-packages", group: "Catalog", title: "List packages", method: "GET", path: "/packages", auth: "bearer", appTypes: ["partner", "lab"],
    summary: "Health packages and the test codes they include.",
    params: [],
    responses: [{ status: 200, description: "Packages.", example: ok({ total: 1, packages: [{ code: "FULLBODY", name: "Full Body Checkup", price: 1999, testCodes: ["CBC", "LFT", "KFT", "TSH"] }] }) }, unauthorized]
  },
  {
    slug: "list-labs", group: "Catalog", title: "List labs", method: "GET", path: "/labs", auth: "bearer", appTypes: ["partner", "lab"],
    summary: "Active partner labs you can book into (a lab app sees only its own lab).",
    params: [],
    responses: [{ status: 200, description: "Labs.", example: ok({ labs: [{ id: "lab-mwh9pxsa-4dbd5a", code: "BELIFE", name: "Belife Diagnostics", city: "Noida" }] }) }, unauthorized]
  },
  {
    slug: "create-booking", group: "Bookings", title: "Create booking", method: "POST", path: "/bookings", auth: "bearer", appTypes: ["partner"],
    summary: "Send a booking to a lab. The lab sees it instantly in its portal or LIS.",
    description: ["Send externalId (your order number) to make retries safe: the same externalId returns the first booking with duplicate: true.", "Test codes come from GET /tests."],
    params: [
      { name: "labId", in: "body", type: "string", required: true, description: "Lab id from GET /labs.", example: "lab-mwh9pxsa-4dbd5a" },
      { name: "externalId", in: "body", type: "string", description: "Your own reference; makes the call idempotent.", example: "CLINIC-ORDER-1001" },
      { name: "patient.name", in: "body", type: "string", required: true, description: "Patient's full name.", example: "Ravi Kumar" },
      { name: "patient.age", in: "body", type: "integer", required: true, description: "Age in ageUnit.", example: 34 },
      { name: "patient.ageUnit", in: "body", type: "year | month | day", description: "Default year." },
      { name: "patient.gender", in: "body", type: "male | female | other", required: true, description: "Gender." },
      { name: "patient.phone", in: "body", type: "string", description: "10-digit mobile number.", example: "9876543210" },
      { name: "tests", in: "body", type: "string[]", required: true, description: "Test codes from GET /tests.", example: ["CBC", "TSH"] },
      { name: "priority", in: "body", type: "routine | urgent | stat", description: "Default routine." },
      { name: "collection", in: "body", type: "home | lab_visit", description: "Sample collection. Default lab_visit." },
      { name: "scheduledAt", in: "body", type: "date-time", description: "Collection time with offset.", example: "2026-11-28T08:30:00+05:30" },
      { name: "notes", in: "body", type: "string", description: "Instructions for the lab (max 1000)." }
    ],
    body: { labId: "lab-mwh9pxsa-4dbd5a", externalId: "CLINIC-ORDER-1001", patient: { name: "Ravi Kumar", age: 34, gender: "male", phone: "9876543210" }, tests: ["CBC", "TSH"], priority: "routine", collection: "home", scheduledAt: "2026-11-28T08:30:00+05:30", notes: "Fasting sample" },
    responses: [
      { status: 201, description: "Created.", example: ok({ booking: { ...exBooking, status: "new", results: [], reports: [], timeline: exBooking.timeline.slice(0, 1) }, duplicate: false }) },
      { status: 200, description: "Same externalId sent again: the first booking.", example: ok({ booking: { "…": "first booking" }, duplicate: true }) },
      { status: 400, description: "Validation failed or unknown test codes.", example: err("unknown_tests", "Unknown test code(s): XYZ. List tests with GET /api/v1/tests.") },
      unauthorized
    ]
  },
  {
    slug: "list-bookings", group: "Bookings", title: "List bookings", method: "GET", path: "/bookings", auth: "bearer", appTypes: ["partner", "lab"],
    summary: "Your bookings, newest change first. Partner apps: bookings they created. Lab apps: their lab's bookings.",
    params: [
      { name: "status", in: "query", type: "string", description: "new, accepted, sample_collected, processing, report_ready, completed, rejected, cancelled." },
      { name: "updatedSince", in: "query", type: "date-time", description: "Only bookings changed after this time (for sync).", example: "2026-11-27T00:00:00Z" },
      { name: "limit", in: "query", type: "integer", description: "1-200, default 50." },
      { name: "offset", in: "query", type: "integer", description: "Default 0." }
    ],
    responses: [{ status: 200, description: "Bookings.", example: ok({ total: 1, limit: 50, offset: 0, bookings: [exBooking] }) }, unauthorized]
  },
  {
    slug: "get-booking", group: "Bookings", title: "Get booking", method: "GET", path: "/bookings/{id}", auth: "bearer", appTypes: ["partner", "lab"],
    summary: "One booking with status, timeline, results and report list.",
    params: [bookingId],
    responses: [{ status: 200, description: "The booking.", example: ok({ booking: exBooking }) }, notFound, unauthorized]
  },
  {
    slug: "cancel-booking", group: "Bookings", title: "Cancel booking", method: "POST", path: "/bookings/{id}/cancel", auth: "bearer", appTypes: ["partner"],
    summary: "Cancel a booking you created while it is still new or accepted.",
    params: [bookingId, { name: "reason", in: "body", type: "string", required: true, description: "Why (3-500 characters).", example: "Patient rescheduled" }],
    body: { reason: "Patient rescheduled" },
    responses: [
      { status: 200, description: "Cancelled.", example: ok({ booking: { ...exBooking, status: "cancelled" } }) },
      { status: 409, description: "Too late to cancel.", example: err("cannot_cancel", "A booking that is \"Processing\" can no longer be cancelled.") },
      notFound
    ]
  },
  {
    slug: "update-status", group: "Lab apps", title: "Update booking status", method: "POST", path: "/bookings/{id}/status", auth: "bearer", appTypes: ["lab"],
    summary: "Move a booking forward: new → accepted → sample_collected → processing → report_ready → completed (or rejected).",
    description: ["Allowed moves: new → accepted | rejected; accepted → sample_collected | rejected; sample_collected → processing; processing → report_ready; report_ready → completed | processing.", "report_ready needs an uploaded report first; rejected needs a note."],
    params: [bookingId, { name: "status", in: "body", type: "string", required: true, description: "The new status.", example: "accepted" }, { name: "note", in: "body", type: "string", description: "Shown on the timeline (required for rejected)." }],
    body: { status: "accepted", note: "Phlebotomist assigned" },
    responses: [
      { status: 200, description: "Updated.", example: ok({ booking: { ...exBooking, status: "accepted" } }) },
      { status: 409, description: "Move not allowed from the current status.", example: err("invalid_transition", "\"New\" cannot move to \"Completed\". Allowed next: accepted, rejected.") },
      notFound
    ]
  },
  {
    slug: "submit-results", group: "Lab apps", title: "Submit results", method: "PUT", path: "/bookings/{id}/results", auth: "bearer", appTypes: ["lab"],
    summary: "Replace the booking's results with this list. Empty values are dropped.",
    params: [bookingId, { name: "results", in: "body", type: "object[]", required: true, description: "{ testCode, testName?, value, unit?, referenceRange?, flag? (normal | low | high | abnormal) }" }],
    body: { results: [{ testCode: "TSH", testName: "Thyroid Stimulating Hormone", value: "2.1", unit: "µIU/mL", referenceRange: "0.4-4.0", flag: "normal" }] },
    responses: [{ status: 200, description: "Saved.", example: ok({ booking: exBooking }) }, { status: 409, description: "Booking closed.", example: err("booking_closed", "This booking is closed.") }, notFound]
  },
  {
    slug: "upload-report", group: "Lab apps", title: "Upload report", method: "POST", path: "/bookings/{id}/reports", auth: "bearer", appTypes: ["lab"],
    summary: "Attach a report file (PDF, PNG or JPEG, up to 3 MB) as base64.",
    params: [bookingId,
      { name: "fileName", in: "body", type: "string", required: true, description: "File name.", example: "ravi-kumar-report.pdf" },
      { name: "mimeType", in: "body", type: "string", required: true, description: "application/pdf, image/png or image/jpeg." },
      { name: "dataBase64", in: "body", type: "string", required: true, description: "The file, base64-encoded. Content must match mimeType." },
      { name: "note", in: "body", type: "string", description: "Optional note (max 300)." }],
    body: { fileName: "ravi-kumar-report.pdf", mimeType: "application/pdf", dataBase64: "JVBERi0xLjQK…" },
    responses: [{ status: 201, description: "Uploaded.", example: ok({ report: exBooking.reports[0], booking: exBooking }) }, { status: 400, description: "Bad file.", example: err("invalid_file", "The file content does not match its mimeType.") }, notFound]
  },
  {
    slug: "download-report", group: "Reports", title: "Download report", method: "GET", path: "/bookings/{id}/reports/{reportId}", auth: "bearer", appTypes: ["partner", "lab"], binary: true,
    summary: "Download a report file. The response is the file itself (Content-Type from the upload).",
    params: [bookingId, { name: "reportId", in: "path", type: "string", required: true, description: "Report id from the booking's reports list.", example: "rpt-mx1abd-1a2b3c" }],
    responses: [{ status: 200, description: "The file (binary).", example: "<binary PDF>" }, { status: 404, description: "No such report.", example: err("report_not_found", "No report with this id on this booking.") }]
  },
  {
    slug: "webhook-events", group: "Webhooks", title: "List event types", method: "GET", path: "/webhooks/events", auth: "bearer", appTypes: ["partner", "lab"],
    summary: "Every event you can subscribe to.",
    params: [],
    responses: [{ status: 200, description: "Events.", example: ok({ events: [{ name: "booking.status_changed", description: "A booking moved to a new status (…)." }] }) }]
  },
  {
    slug: "list-webhooks", group: "Webhooks", title: "List webhooks", method: "GET", path: "/webhooks", auth: "bearer", appTypes: ["partner", "lab"],
    summary: "Your app's webhooks with their last delivery status.",
    params: [],
    responses: [{ status: 200, description: "Webhooks.", example: ok({ webhooks: [{ id: "wh_mx1abf2c3d4e5f", clientId: "hjc_…", url: "https://example.com/healjour/webhooks", events: ["booking.status_changed", "booking.report_uploaded"], active: true, createdAt: "2026-11-27T09:00:00.000Z", lastDeliveryAt: "2026-11-28T16:05:12.000Z", lastStatus: 200 }] }) }]
  },
  {
    slug: "create-webhook", group: "Webhooks", title: "Register webhook", method: "POST", path: "/webhooks", auth: "bearer", appTypes: ["partner", "lab"],
    summary: "Register an https URL for events. The signing secret is returned only in this response.",
    params: [
      { name: "url", in: "body", type: "string", required: true, description: "Public https URL (port 443).", example: "https://example.com/healjour/webhooks" },
      { name: "events", in: "body", type: "string[]", required: true, description: "Event names from GET /webhooks/events.", example: ["booking.status_changed", "booking.report_uploaded"] }
    ],
    body: { url: "https://example.com/healjour/webhooks", events: ["booking.status_changed", "booking.report_uploaded"] },
    responses: [
      { status: 201, description: "Registered. Store the secret.", example: ok({ webhook: { id: "wh_mx1abf2c3d4e5f", url: "https://example.com/healjour/webhooks", events: ["booking.status_changed", "booking.report_uploaded"], active: true, secret: "whsec_…" } }) },
      { status: 400, description: "URL refused.", example: err("invalid_url", "Webhook URLs must use https://.") }
    ]
  },
  {
    slug: "delete-webhook", group: "Webhooks", title: "Delete webhook", method: "DELETE", path: "/webhooks/{id}", auth: "bearer", appTypes: ["partner", "lab"],
    summary: "Stop sending events to this URL.",
    params: [{ name: "id", in: "path", type: "string", required: true, description: "Webhook id.", example: "wh_mx1abf2c3d4e5f" }],
    responses: [{ status: 200, description: "Deleted.", example: ok({ deleted: true }) }, { status: 404, description: "No such webhook.", example: err("webhook_not_found", "No webhook with this id on your app.") }]
  }
];

export const NAV_GROUPS = ["Get started", "Authentication", "Catalog", "Bookings", "Lab apps", "Reports", "Webhooks"];

// ---------------- OpenAPI 3.1 (for Postman, Insomnia, code generators) ----------------
export function buildOpenApi(serverUrl = "/api/v1") {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of ENDPOINTS) {
    const op: Record<string, unknown> = {
      operationId: e.slug, summary: e.title, description: [e.summary, ...(e.description ?? []), `App types: ${e.appTypes.join(", ")}.`].join("\n\n"), tags: [e.group],
      ...(e.auth === "bearer" ? { security: [{ bearerAuth: [] }] } : { security: [] }),
      parameters: e.params.filter(p => p.in !== "body").map(p => ({ name: p.name, in: p.in, required: Boolean(p.required || p.in === "path"), description: p.description, schema: { type: p.type === "integer" ? "integer" : "string" }, ...(p.example !== undefined ? { example: p.example } : {}) })),
      responses: Object.fromEntries(e.responses.map(r => [String(r.status), {
        description: r.description,
        content: e.binary && r.status === 200 ? { "application/octet-stream": { schema: { type: "string", format: "binary" } } } : { "application/json": { example: r.example } }
      }]))
    };
    if (e.body) op.requestBody = { required: true, content: { "application/json": { example: e.body } } };
    (paths[e.path] ??= {})[e.method.toLowerCase()] = op;
  }
  return {
    openapi: "3.1.0",
    info: { title: "Healjour API", version: "1.0.0", description: "Bookings, results, reports and webhooks for clinics, hospitals, corporates, insurers and partner labs. Docs: /developers" },
    servers: [{ url: serverUrl }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "Access token from POST /auth/token" } } },
    tags: NAV_GROUPS.filter(g => g !== "Get started").map(name => ({ name })),
    paths
  };
}
