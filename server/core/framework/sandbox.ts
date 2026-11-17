// In-process sandbox partner ("mock://" base URL). It behaves like a real partner API so every
// framework behaviour can be shown and tested without a real account:
//   ?scenario=ok            201 Created
//   ?scenario=flaky         503 on the first 2 attempts, then 201        (retry with backoff)
//   ?scenario=ratelimited   429 + Retry-After: 1 once, then 201          (rate-limit handling)
//   ?scenario=outage        503 for 30 seconds, then 201                 (dead letter, later replay)
//   ?scenario=bad_request   400, never retried                           (partner rejects the data)
//   ?scenario=unauthorized  401, never retried                           (wrong credentials)
// It requires the header x-api-key: sandbox-key, like a partner that uses API keys.

import { partnerSandbox } from "./sandbox-partners.js";

const attemptsByKey = new Map<string, number>();
const outageStart = new Map<string, number>();
const OUTAGE_MS = 30_000;

function remember<T>(map: Map<string, T>, key: string, value: T) {
  map.set(key, value);
  if (map.size > 5000) { const first = map.keys().next().value; if (first !== undefined) map.delete(first); }
}

type MockRequest = { host: string; method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: unknown; attemptKey: string };
type MockResponse = { status: number; headers: Record<string, string>; data: unknown };

export async function mockTransport(req: MockRequest): Promise<MockResponse> {
  await new Promise(r => setTimeout(r, 40 + Math.random() * 60)); // a little network latency
  if (req.host !== "sandbox") {
    const partner = partnerSandbox(req.host, req as Parameters<typeof partnerSandbox>[1]);
    return partner ?? { status: 404, headers: {}, data: { error: `No sandbox partner "${req.host}".` } };
  }
  const json = (status: number, data: unknown, headers: Record<string, string> = {}): MockResponse => ({ status, headers, data });
  if (req.headers["x-api-key"] !== "sandbox-key") return json(401, { error: "invalid_api_key", message: "x-api-key header is missing or wrong." });

  const scenario = req.query.scenario ?? "ok";
  const key = `${scenario}:${req.attemptKey}`;
  const n = (attemptsByKey.get(key) ?? 0) + 1;
  remember(attemptsByKey, key, n);
  const created = () => json(201, {
    id: `SBX-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
    status: "created",
    version: req.path.split("/").filter(Boolean)[0] ?? "",
    idempotencyKey: req.headers["Idempotency-Key"] ?? null,
    received: req.body
  });

  switch (scenario) {
    case "flaky": return n <= 2 ? json(503, { error: "temporarily_unavailable" }) : created();
    case "ratelimited": return n === 1 ? json(429, { error: "rate_limited" }, { "retry-after": "1" }) : created();
    case "outage": {
      const start = outageStart.get(key) ?? Date.now();
      if (!outageStart.has(key)) remember(outageStart, key, start);
      return Date.now() - start < OUTAGE_MS ? json(503, { error: "service_down", retryInSeconds: Math.ceil((OUTAGE_MS - (Date.now() - start)) / 1000) }) : created();
    }
    case "bad_request": return json(400, { error: "validation_failed", message: "patient.mobile is not valid" });
    case "unauthorized": return json(401, { error: "invalid_api_key" });
    default: return created();
  }
}
