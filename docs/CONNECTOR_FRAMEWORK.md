# Connector framework

One standard way for Healjour to call any partner system (HIS/LIS, communication, CRM, payments, App Store apps).
A new integration is a **connector definition plus mapping specs**, not new plumbing.

Code: `server/core/framework/` · Routes: `server/framework-routes.ts` · Admin page: **Connector Framework** in the sidebar.

## What every call gets

| Concern | How it works |
|---|---|
| Authentication | `none`, `api_key`, `bearer`, `basic`, `oauth2_client_credentials` (token cached until 30 s before expiry). Secrets come from server environment variables, never from the browser. |
| Rate limit | Token bucket per connector, e.g. 5 requests per second. Calls wait for a token instead of failing. |
| Retries | Exponential backoff with jitter (50–100 % of `base × 2^(try-1)`, capped). Retries on 408, 425, 429, 5xx and network errors. Honours `Retry-After`. Never retries 4xx data/auth errors or a missing credential. |
| Timeout | Per connector (`timeoutMs`); a timeout counts as a network error and is retried. |
| Idempotency | Caller passes a key. The key is sent as `Idempotency-Key`; a successful result is stored for 24 h, and the same key returns the stored result without calling the partner again. |
| Versioning | Each operation has a path per API version (`v1`, `v2`), and a request mapping per version. Old and new versions run side by side; the caller picks one. |
| Field mapping | Declarative rules (`from` → `transform` → `to`), with `required`, `default` and `const`. Transforms: trim, upper, lower, number, boolean, phone10, isoDate, gender, split, join, `prefix:`, `map:{...}`. Mapping errors stop the call before anything is sent. |
| Call log | Every call is written to `connectorCalls`: connector, operation, version, status, tries, duration, idempotency key, correlation ID. |
| Dead letters | A call that still fails after all retries goes to `connectorDeadLetters` with its payload and key. **Replay** sends it again with the same key, so the partner never creates it twice. |
| Correlation | Each call carries `X-Correlation-Id`, kept across replays, for tracing with the partner's logs. |

## Add a connector

```ts
// server/core/framework/registry.ts
registerConnector({
  id: "razorpay",
  name: "Razorpay",
  family: "payments",
  description: "Payment links, refunds, settlements",
  baseUrl: "https://api.razorpay.com",
  defaultVersion: "v1",
  versions: ["v1"],
  auth: { type: "basic", userEnv: "RAZORPAY_KEY_ID", passEnv: "RAZORPAY_KEY_SECRET" },
  retry: DEFAULT_RETRY,
  rateLimit: { requests: 10, perMs: 1000 },
  timeoutMs: 15000,
  managedBy: "framework",
  operations: {
    createPaymentLink: { method: "POST", paths: { v1: "/v1/payment_links" }, mapRequest: { v1: PAYMENT_LINK_V1 } }
  }
});

// anywhere on the server
const result = await callConnector("razorpay", "createPaymentLink", { body: booking, idempotencyKey: booking.id });
if (!result.ok) { /* already in dead letters; result.error says why */ }
```

## Try it (no partner account needed)

The built-in **Partner Sandbox** (`mock://sandbox`) behaves like a real API. On the **Test bench** pick a scenario:

| Scenario | Partner behaviour | What you should see |
|---|---|---|
| Success | 201 at once | 1 try |
| Flaky | 503, 503, then 201 | 3 tries with growing waits |
| Rate limited | 429 + `Retry-After: 1`, then 201 | 2 tries, about 1 s apart |
| Outage | 503 for 30 s | 4 failed tries, item in Dead letters; Replay after 30 s delivers it |
| Bad data | 400 | 1 try, no retry, item in Dead letters |
| Wrong key | 401 | 1 try, no retry |

Run the same idempotency key twice: the second run says *Returned from idempotency store* and the partner is not called.

## Runbook: a dead letter appeared

1. Open **Connector Framework → Dead letters** and read the error.
2. `HTTP 5xx`, `429` or timeout: the partner was down or slow. Check their status page, then **Replay**.
3. `HTTP 400`: the data was rejected. Fix the source record or the mapping (test it in **Mapping playground**), then send a new call. Do not replay unchanged data.
4. `HTTP 401/403` or "Missing credential": the key or secret is wrong or expired. Update the environment variable, redeploy, then **Replay**.
5. Replaying is safe: the same idempotency key is sent, so the partner treats it as the same request.

## Tests

16 checks run in memory mode (no database): v1/v2 mapping, retry with backoff, Retry-After, no retry on 400/401, mapping errors block the call, idempotency, rate limit, outage → dead letter → failed replay → successful replay.

## Known limits and next steps

- Rate-limit buckets, OAuth token cache and sandbox state live in server memory, so each server instance has its own. A shared store (e.g. Redis) is needed when running many instances.
- Dead letters store the request payload, which can contain patient data. Encrypting it at rest is part of the data-protection work.
- Flabs is listed in the registry but still uses its own client (`server/core/flabs/`). Moving its calls onto `callConnector()` is the next migration.
- Alerts on new dead letters and a daily reconciliation job are part of the reliability-ops step.
