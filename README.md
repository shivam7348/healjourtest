# Healjour Integration Studio — CSV/SFTP Wizard Demo

A React + TypeScript configuration wizard and Express/Zod validation API for the proposed integration:

- Name: `Noida Lab — CSV Connector`
- Lab code: `LAB-NOIDA-01`
- Source: Healjour
- Target: Lab
- Protocol: CSV
- Transport: SFTP (configuration only)
- Delimiter: comma
- Polling interval: 5 minutes
- Direction: bidirectional

## Important scope and limitations

This is a working **local demo scaffold**, not an official Healjour product and not connected to a production system. It does not connect to a real SFTP server, store persistent drafts, send patient data, or deploy a connector. The test endpoint runs synthetic checks only. Do not put real patient data or real credentials into this demo.

## Requirements

- Node.js 20 or later
- npm

## Run locally

```bash
npm install
npm run dev
```

- UI: http://localhost:5174
- Demo API: http://localhost:4000/api/health

To build the frontend:

```bash
npm run build
```

## Implemented

- Sidebar navigation (non-wizard pages are clearly marked placeholders)
- Five-step configuration wizard
- Basic integration details and bidirectional/outbound/inbound selection
- CSV/SFTP transport settings, delimiter, polling interval, inbound/outbound paths
- Local sample CSV header preview
- Outbound/inbound mapping editor UI with illustrative fields
- Configurable validation safeguards
- Backend validation contract using Zod
- Synthetic sandbox test endpoint
- Explicit warning that no live SFTP connection or production deployment exists

## API contract

### `POST /api/integrations/validate`

Accepts the configuration JSON from the UI. Returns `200` with `valid: true` and warnings, or `400` with field/path validation errors.

### `POST /api/integrations/test`

Runs synthetic configuration/fixture checks only. The response includes `live_sftp_connectivity: not_run`.

### `GET /api/health`

Returns demo service status and `productionConnection: false`.

## Production implementation still required

1. Integrate with Healjour's approved API/event contract and configuration store.
2. Implement SFTP with host-key verification, managed credentials, strict allowlists, path restrictions and atomic file handoff.
3. Implement durable job scheduling, file checksum tracking, idempotency, retries and dead-letter handling.
4. Parse CSV using a robust parser (quoted commas/newlines, BOM, encoding, size limits); validate against partner-approved schemas.
5. Persist versioned mappings and approvals in a database.
6. Implement role-based authorization, audit trails, tenant isolation, monitoring, retention controls and security review.
7. Add real partner connectivity tests only in a controlled sandbox with authorized credentials.
8. Add deployment/rollback workflow only after review and approval.

The default folder paths in the UI are examples. Confirm exact paths and file contract with the lab before enabling any real connector.

## Partner Access — credential workflow (demo)

The **Partner Access** navigation item adds a functional in-memory demo for:

- Admin approval or rejection of lab access requests.
- A lab self-service portal that blocks credential creation until approval.
- Permission selection: `orders:read`, `orders:write`, `results:read`, `results:write`, `reports:read`.
- Server-generated Client IDs and high-entropy Client Secrets.
- One-time secret display: the raw secret is not returned by the lab-list API; only a scrypt-derived verifier is held in memory.
- Secret rotation, which replaces the previous secret and invalidates issued demo tokens.
- Credential revocation, which disables the client and invalidates its issued demo tokens.
- `POST /oauth/token` using the OAuth 2.0 client-credentials grant. It verifies the Client ID/Secret and refuses scopes that were not assigned to that lab. Demo tokens are opaque, short-lived (15 minutes), and stored as hashes in memory.

### Demo API routes

- `GET /api/partner-access/labs` — list demo lab metadata; never returns a Client Secret.
- `POST /api/partner-access/labs/:id/decision` — `{ "decision": "approved" | "rejected" }`.
- `POST /api/partner-access/labs/:id/credentials` — `{ "scopes": ["orders:read", "results:write"] }`.
- `POST /api/partner-access/labs/:id/rotate` — `{ "scopes": ["orders:read"] }`.
- `POST /api/partner-access/labs/:id/revoke` — revoke active credentials.
- `POST /oauth/token` — `{ "grant_type": "client_credentials", "client_id": "...", "client_secret": "...", "scope": "orders:read results:write" }`.

The seeded Faridabad demo account has the demo secret `demo-secret-never-use-in-production` solely so the token endpoint can be tried locally. Never use that credential anywhere else. Prefer generating a fresh credential through the Lab portal.

### Important production gaps

This is not production-ready identity or access management. The admin/lab role selector is a UI preview, **not authentication**. The API routes currently do not enforce real user sessions or admin RBAC, and all lab records/tokens disappear when the server restarts. Before production, implement authenticated admin and lab sessions, server-side tenant isolation, durable database transactions, audit logs, CSRF/origin protections as appropriate, rate limiting, alerting, secret management, secure deployment/TLS, token cleanup, and independent security review. A production token endpoint must be connected to approved protected Healjour API routes with scope middleware and the real API contract. No real Healjour production endpoint is implied by this demo.
