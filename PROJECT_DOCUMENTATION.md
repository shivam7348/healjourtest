# Healjour Integration Studio

Healjour Integration Studio is a local demonstration application for configuring CSV-based integrations between the Healjour platform and diagnostic laboratories. It includes a five-step integration wizard, a partner-access credential workflow, and an Express API for configuration validation and synthetic testing.

> This repository is a demonstration scaffold. It is not connected to Healjour production systems and must not be used with real patient data or production credentials.

## Features

- Healjour Core: four runnable integration layers (Connector Mesh, Normalization, Identity & Consent, Orchestration)
- HL7 v2, FHIR R4, CSV and JDBC source connectors with bi-directional write-back
- Canonical schema mapping to FHIR R4 with an approved test and unit catalog
- Master patient index with deterministic and probabilistic stitching
- Consent enforcement per destination and a hash-chained audit log
- Sink routing with bounded retries, SLA measurement, dead-letter queue and replay
- Five-step CSV integration configuration wizard
- Bidirectional, outbound-only, and inbound-only data flows
- SFTP, managed gateway, and local-folder transport options
- CSV delimiter, polling interval, and folder-path configuration
- Outbound order and inbound result field mappings
- Sample CSV header import and preview
- Configurable validation and clinical-data safeguards
- Synthetic configuration test endpoint
- Lab access approval and rejection workflow
- OAuth-style client credential generation, rotation, and revocation
- Short-lived demo access tokens with permission scopes
- Responsive React administration interface

## Technology Stack

| Layer | Technology |
| --- | --- |
| Frontend | React 18, TypeScript, Vite |
| Styling | Custom CSS |
| Icons | Lucide React |
| Backend | Node.js, Express, TypeScript |
| Validation | Zod |
| Development runner | tsx, concurrently |

## Project Structure

```text
healjour-integration-studio/
├── server/
│   ├── core/
│   │   ├── types.ts            # Canonical shapes shared by the four layers
│   │   ├── connectors.ts       # Layer 01 - Connector Mesh
│   │   ├── normalization.ts    # Layer 02 - Normalization
│   │   ├── identity.ts         # Layer 03 - Identity & Consent
│   │   ├── orchestration.ts    # Layer 04 - Orchestration
│   │   └── pipeline.ts         # Layer runner, topology and sample payloads
│   └── index.ts            # Express API and demo credential registry
├── src/
│   ├── App.tsx             # Integration wizard and partner-access UI
│   ├── CoreLayers.tsx      # Healjour Core flow board and pipeline runner
│   ├── core-layers.css     # Healjour Core styles
│   ├── main.tsx            # React application entry point
│   └── styles.css          # Application styles
├── index.html              # Vite HTML entry point
├── package.json            # Dependencies and npm scripts
├── vite.config.ts          # Vite server and API proxy configuration
└── PROJECT_DOCUMENTATION.md
```

## Requirements

- Node.js 20 or later
- npm

## Installation

Open PowerShell in the project directory and install the dependencies:

```powershell
npm install
```

## Running the Project

Start the frontend and backend together:

```powershell
npm run dev
```

Open the application at:

```text
http://localhost:4000
```

During development, port `4000` redirects browser requests to the Vite frontend on port `5174`.

| Service | Address |
| --- | --- |
| Application entry point | `http://localhost:4000` |
| React development server | `http://localhost:5174` |
| API health check | `http://localhost:4000/api/health` |

Port `5174` is intentionally used because port `5173` may already be occupied by another local Vite project.

### Run Services Separately

Backend only:

```powershell
npm run dev:server
```

Frontend only:

```powershell
npm run dev:client
```

## Production Build

Create an optimized frontend build:

```powershell
npm run build
```

Start the Express server:

```powershell
npm start
```

When a `dist` directory is present, the Express server serves the compiled frontend from port `4000`.


## Storage

All persistent state goes through `server/core/store.ts`:

| Collection | Holds |
| --- | --- |
| `patients` | Master patient index, aliases and consents |
| `audit` | Hash-chained audit events (append-only) |
| `deadLetters` | Deliveries that exhausted their retries |
| `runs` | Pipeline run history |
| `partnerLabs` | Lab access status and salted credential verifiers (never plain secrets) |
| `accessTokens` | Issued bearer tokens, hashed, with a TTL index on expiry |

Configure the connection with environment variables:

```powershell
$env:MONGODB_URI = "mongodb+srv://<user>:<password>@<cluster>/"
$env:MONGODB_DB  = "healjour_integration_studio"   # optional
npm run dev
```

Default URI is `mongodb://127.0.0.1:27017`. If the server cannot be reached at startup the API
falls back to an in-memory store and says so on `GET /api/health` (`storage.durable: false`).
Never commit the connection string.

## Healjour Core Layers

The **Core Layers** screen implements the four layers that sit between a legacy source and a
modern sink. Each layer runs server-side, returns its own trace, and can stop the pipeline so
nothing downstream sees a record the layer above it refused to pass.

### Layer 01 — Connector Mesh

Typed, bi-directional adapters, one per source dialect.

| Connector | Source | Format | Transport |
| --- | --- | --- | --- |
| `lis-hl7v2-oru` | Hospital LIS | HL7 v2 (ORU^R01 / ORM^O01) | MLLP, SFTP |
| `path-csv-results` | Pathology labs | Delimited export | SFTP, local folder |
| `diag-fhir-r4` | Diagnostic centres | FHIR R4 Bundle | HTTPS |
| `lis-jdbc-poll` | Hospital LIS | JDBC result rows (JSON) | JDBC |

Each adapter reads the payload into `RawRecord[]` in the source's own field names and checks the
connector's required fields. `writeBack()` renders a canonical record back into the same dialect,
which is the outbound half of the bi-directional contract.

### Layer 02 — Normalization

Maps source fields to a canonical record and projects it to FHIR R4 (`Patient`,
`ServiceRequest`, `Observation`). It maps local test codes to LOINC through an approved catalog,
normalizes units to UCUM, maps result statuses and priorities, and parses ISO, HL7 and `dd/MM/yyyy`
dates. Anything it cannot map — an unknown test code, an unknown unit, an unparsable date — is
flagged or quarantined. Nothing is silently converted.

### Layer 03 — Identity & Consent

Resolves each record against an in-memory master patient index:

1. Deterministic match on MRN or national identifier (confidence 1.0).
2. Phone plus date of birth (0.95).
3. Probabilistic demographic scoring, capped below the auto-stitch threshold.

A record only auto-stitches at confidence 0.9 or above, and a near-tie between two patients is
held for human review rather than merged. New identifiers seen on a matched patient are linked as
aliases. The layer then checks the consent each requested destination needs
(`treatment`, `underwriting`, `claims`, `marketplace`, `wellness`, `research`) and drops the
destinations the patient has not consented to or whose consent has expired. Every stitch, alias,
consent change and delivery is appended to a SHA-256 hash-chained audit log that can be verified
end to end.

### Layer 04 — Orchestration

Routes each record to the sinks that accept it, by record kind, result finality and subscribed
panel. Delivery uses bounded exponential backoff (per-sink `maxAttempts` and `backoffMs`), measures
total latency against the sink's SLA budget, and parks exhausted deliveries on a dead-letter queue
that can be replayed. Delivery is simulated deterministically in-process; no sink is contacted.

### Core API Endpoints

```http
GET  /api/core/topology              # sources, layers, sinks, connectors, sample list
GET  /api/core/samples/:id           # one sample payload
POST /api/core/pipeline/run          # run a payload through all four layers
GET  /api/core/runs                  # run history, dead letters, audit log, chain state
POST /api/core/dead-letters/:id/replay
GET  /api/core/patients              # master patient index
POST /api/core/patients/:id/consent  # grant or withdraw a consent purpose
```

Run request body:

```json
{
  "connectorId": "lis-hl7v2-oru",
  "payload": "MSH|^~\&|LIS|...",
  "sinks": ["healjour_record", "insurer_underwriting"],
  "failureMode": "auto",
  "normalization": { "rejectUnknownTestCodes": true, "validateDates": true, "requireApprovedResults": true },
  "quarantineOnAmbiguity": true
}
```

`failureMode` controls the simulated sink: `auto` (mixed), `none`, `transient` (exercises retries)
or `permanent` (exercises the dead-letter queue).

## Integration Wizard

The Integration Studio contains five steps:

1. **Basic details** — integration name, lab code, source, target, and direction.
2. **File transport** — transport mechanism, delimiter, polling interval, and folder paths.
3. **Schema mapping** — maps Healjour fields to the laboratory CSV format.
4. **Validation rules** — enables header, code, duplicate, date, approval, and patient-match checks.
5. **Test and deploy** — validates the draft and runs synthetic sandbox checks.

The deployment action is intentionally disabled. A successful test means only that the local configuration and synthetic fixtures passed validation.

## Partner Access Workflow

The Partner Access screen demonstrates how a lab could receive integration credentials:

1. A laboratory requests platform access.
2. An administrator approves or rejects the request.
3. An approved laboratory selects its permission scopes.
4. The server generates a Client ID and Client Secret.
5. The Client Secret is displayed once and stored only as a derived verifier.
6. Credentials can be rotated or revoked.
7. Active credentials can request a short-lived access token.

The registry is stored in memory and resets whenever the backend restarts.

## API Endpoints

### Health Check

```http
GET /api/health
```

Returns the demo service status.

### Validate Integration

```http
POST /api/integrations/validate
Content-Type: application/json
```

Validates the integration schema and inbound/outbound folder paths.

### Run Synthetic Test

```http
POST /api/integrations/test
Content-Type: application/json
```

Runs configuration and fixture checks. It does not contact an actual SFTP server.

### List Partner Labs

```http
GET /api/partner-access/labs
```

Returns public lab metadata. Client Secrets are never returned by this endpoint.

### Approve or Reject a Lab

```http
POST /api/partner-access/labs/:id/decision
Content-Type: application/json

{
  "decision": "approved"
}
```

### Generate Credentials

```http
POST /api/partner-access/labs/:id/credentials
Content-Type: application/json

{
  "scopes": ["orders:read", "results:write"]
}
```

### Rotate Credentials

```http
POST /api/partner-access/labs/:id/rotate
Content-Type: application/json

{
  "scopes": ["orders:read", "results:write"]
}
```

### Revoke Credentials

```http
POST /api/partner-access/labs/:id/revoke
```

### Request an Access Token

```http
POST /oauth/token
Content-Type: application/json

{
  "grant_type": "client_credentials",
  "client_id": "generated-client-id",
  "client_secret": "generated-client-secret",
  "scope": "orders:read results:write"
}
```

Demo access tokens expire after 15 minutes.

## Available Permission Scopes

- `orders:read`
- `orders:write`
- `results:read`
- `results:write`
- `reports:read`

## Important Limitations

- No production Healjour connection
- No real SFTP connection
- No authenticated user sessions or production RBAC
- No tenant isolation
- No production secret manager or key-management service
- No real delivery to insurers, aggregators or corporates; Layer 04 simulates every call
- No terminology server; the test and unit catalogs are a short hardcoded list
- No human review queue behind the identity layer's quarantine decisions
- No real patient-data processing
- No production deployment workflow

## Production Readiness Requirements

Before using a similar system in production:

- Add authenticated sessions and role-based authorization.
- Store integrations, lab records, and audit events in a tenant-scoped database.
- Store credentials in an approved secrets-management system.
- Add SFTP host-key verification, network allowlists, and least-privilege accounts.
- Implement durable scheduling, retries, idempotency, checksums, and dead-letter handling.
- Use a robust CSV parser with encoding, quoting, file-size, and schema controls.
- Add monitoring, alerting, retention policies, and security review.
- Complete privacy, compliance, and clinical-safety assessments.

## Troubleshooting

### `Cannot GET /` on port 4000

Restart the backend after pulling the latest code:

```powershell
npm run dev:server
```

Port `4000` should redirect to the active frontend during development.

### A different project opens

Open `http://localhost:5174` directly. This project does not use port `5173`, because another Vite application may already be running there.

### API calls fail

Confirm that the backend health endpoint responds:

```text
http://localhost:4000/api/health
```

Expected response:

```json
{
  "status": "ok",
  "mode": "demo",
  "productionConnection": false
}
```

## Safety Notice

Use synthetic data only. Do not enter patient information, laboratory production credentials, or any other sensitive data into this demonstration application.
