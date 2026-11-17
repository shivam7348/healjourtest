# Integration Hub

Admin page: **Integration Hub** in the sidebar. Code: `server/core/hub/`, routes in `server/hub-routes.ts`, UI in `src/hub/`.
Every partner call runs on the [connector framework](CONNECTOR_FRAMEWORK.md): retries, idempotency, rate limits, call log, dead letters.

Each connector runs against the **real partner** when its keys are set on the server, and against a built-in **sandbox partner** otherwise. The sandbox answers like the real API, so every flow can be shown and tested without accounts. The mode is shown next to each connector.

## Payments (Razorpay, HDFC SmartGATEWAY)

| Feature | How |
|---|---|
| Payment link | `POST /v1/payment_links`; idempotency key = booking + amount, so a retry never makes a second link |
| Webhook | `POST /api/webhooks/payments/razorpay`. HMAC-SHA256 of the raw body checked in constant time; repeat events ignored by event ID |
| Refund | Full or partial, never more than what is left; each refund has its own idempotency key |
| Reconciliation | Fetches the settlement report and classifies each payment: matched, amount differs, missing (> 3 days), settles soon, unknown to us. Mismatches raise an alert |

Sandbox: **Patient pays**, **Pay (settles less)** to create a reconciliation mismatch, **Fails**.
HDFC runs in sandbox until merchant onboarding; confirm its live paths against HDFC's docs before setting `HDFC_BASE_URL`.

## Communication (Exotel, Gmail, Google Calendar)

- SMS (Exotel, form-encoded like the real API) and email (Gmail, RFC 822 `raw`), from editable templates.
- Delivery tracking from Exotel's status callback `POST /api/webhooks/comms/exotel/<token>`. A failed SMS falls back to email.
- Reminders 24 h and 2 h before each scheduled booking (scheduled once, sent by the dispatcher).
- Google Calendar events for home collections, and a `.ics` download that works with any calendar.
- Click-to-call (staff phone rings first, then the patient) and an IVR menu that answers `POST /api/webhooks/comms/ivr/<token>` with a route.

## Leads and CRM (Meta, Google Ads, Justdial, Practo, website → LeadSquared)

- One webhook URL per source, each with a secret token. Meta also supports the `hub.challenge` handshake and `X-Hub-Signature-256` (when `META_APP_SECRET` is set); Google lead forms check `google_key`.
- Meta webhooks carry only the lead ID, so the form answers are fetched from the Graph API.
- Source-specific mapping specs turn each payload into one lead shape; phone numbers are cleaned to 10 digits.
- A phone seen again within 7 days updates the existing lead (no duplicates).
- New leads are pushed to LeadSquared.
- Enquiry → booking: creating a booking for the same phone marks the lead booked. Attribution shows leads, bookings, conversion and revenue per source and campaign.

## App Store partner layer

- Developers register an app (scopes, redirect URI, webhook URL, privacy policy) and get a client secret (stored hashed) and a webhook signing secret, shown once.
- Apps start in the **Sandbox Lab** (synthetic data). Real centres can install only after review: five checks (privacy, minimal scopes, security, sandbox-tested, support) must pass.
- A centre installs the app and grants scopes → authorization code (10 min, single use) → `POST /api/appstore/oauth/token` for an access token (1 h) and a rotating refresh token.
- `GET /api/apps/v1/cases` and `/cases/{caseNo}/results` return only the installing centre's data, without phone or address; missing scope → 403, revoked/suspended → 401.
- Events are delivered signed (`X-Healjour-Signature: sha256=…`). Redirect and webhook URLs must be public HTTPS (no localhost or private IPs).
- Developer docs are on the page (Show developer docs).

## Reliability

- **Alerts**: dead letters, connector failure rate > 20 % in an hour, reconciliation mismatches, failed messages, leads waiting > 24 h, bookings without a report after 48 h. One alert per problem (repeats bump a counter). Posted to Slack (`ALERT_SLACK_WEBHOOK_URL`) or the sandbox channel.
- **Runbooks** for each alert type, linked from the alert.
- **Jobs**: `vercel.json` runs `/api/cron/daily` (reconciliation, reminders, checks, retention) and `/api/cron/dispatch` (reminders). Both need `Authorization: Bearer $CRON_SECRET`. Vercel's free plan runs crons once a day; run the dispatcher more often on a paid plan or an external scheduler.

## Data protection (DPDP Act, ABDM)

- AES-256-GCM encryption for name, phone, email, message text and dead-letter payloads; keyed blind index to search by phone. Set `DATA_ENCRYPTION_KEY` (32 bytes, base64) before real data; losing it makes stored data unreadable.
- Retention per record type, with a dry run; deletion only when you press it or turn on auto-delete. Payments are kept 8 years (tax) and can only be anonymised.
- Consent records export (CSV/JSON) with ABDM purpose codes.
- Data principal requests: find everything held for a phone, export it, or erase it (typed confirmation). Every search and erasure goes to the audit trail.
- Not built yet: the ABDM gateway itself (ABHA linking, HIP/HIU consent flows).

## Server settings

| Variable | Used for |
|---|---|
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Razorpay live |
| `HDFC_BASE_URL`, `HDFC_API_KEY`, `HDFC_MERCHANT_ID`, `HDFC_WEBHOOK_SECRET` | HDFC live |
| `EXOTEL_SID`, `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN`, `EXOTEL_SUBDOMAIN`, `EXOTEL_SENDER_ID`, `EXOTEL_CALLER_ID` | SMS and calls |
| `GOOGLE_ACCESS_TOKEN`, `EMAIL_FROM` | Gmail and Calendar (a short-lived token; production needs an OAuth refresh flow) |
| `LSQ_HOST`, `LSQ_ACCESS_KEY`, `LSQ_SECRET_KEY` | LeadSquared |
| `META_PAGE_TOKEN`, `META_APP_SECRET`, `GOOGLE_LEADS_KEY`, `LEADS_WEBHOOK_TOKEN` | Lead sources |
| `COMMS_WEBHOOK_TOKEN` | Exotel callback and IVR URL token |
| `ALERT_SLACK_WEBHOOK_URL` | Alerts to Slack |
| `CRON_SECRET` | Scheduled jobs |
| `DATA_ENCRYPTION_KEY` | Encryption at rest |
| `PUBLIC_BASE_URL` | Webhook URLs shown on the page |

## Tests

59 checks in memory mode (no database): payment link idempotency, bad webhook signature, signed paid webhook, partial and over-refund, reconciliation match and mismatch; SMS, delivery report, DND failure with email fallback, form-encoded callback, wrong callback token, IVR, click-to-call; Meta Graph lead, Google lead, de-duplication, CRM sync, webhook token, Meta handshake, attribution; App Store registration, private URL refused, sandbox install, wrong secret, form-encoded code exchange, code reuse refused, scoped API, missing scope 403, refresh rotation, signed event, review gate, revoked token 401; dead letter → alert → ops channel → repeat bumps the same alert; daily job, cron secret; encrypted lead and dead-letter storage, access request, erasure confirmation, erasure, anonymised payment, retention dry run, consent CSV.
