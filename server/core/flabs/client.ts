// Thin client for the Flabs CRM API (https://developer.flabslis.com).
// Handles login, token refresh and error classification. Nothing here knows about
// Healjour records; the mapper and sink do that. Connections are managed in connection.ts.

export type FlabsPhase = "lead" | "booking";
export type FlabsParty = { field: "corporateUser" | "referredOrganization" | "referredHospitalOrganization"; id: string };

/** One Flabs account. Several can exist: a lab, and one or more corporate or referral accounts. */
export type FlabsConfig = {
  id: string;
  label: string;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  branchId?: string;
  phase: FlabsPhase;
  party?: FlabsParty;
  webhookToken?: string;
};

export class FlabsError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
  /** 5xx and network failures are worth retrying; 4xx means the payload or setup is wrong. */
  get retryable() {
    return this.status === 0 || this.status >= 500;
  }
}

type Session = { authToken: string; refreshToken: string; expiresAt: number };
// One cached login per Flabs account, so connections never share or overwrite each other's session.
const sessions = new Map<string, Session>();
const sessionKey = (config: FlabsConfig) => `${config.baseUrl}|${config.clientId}`;
// Refresh a little early so a token never expires mid-request.
const EXPIRY_MARGIN_MS = 60_000;

async function call(config: FlabsConfig | { baseUrl: string }, path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(15_000)
    });
  } catch (error) {
    throw new FlabsError(0, `Flabs unreachable: ${error instanceof Error ? error.message : "network error"}`);
  }
  const text = await response.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.slice(0, 200) }; }
  return { status: response.status, body };
}

async function login(config: FlabsConfig): Promise<Session> {
  const { status, body } = await call(config, "/client/auth/token", {
    method: "POST",
    body: JSON.stringify({ clientID: config.clientId, clientSecret: config.clientSecret })
  });
  if (status !== 200 || !body.authToken) throw new FlabsError(status, body.message || body.error?.details || "Flabs login failed.");
  return { authToken: body.authToken, refreshToken: body.refreshToken, expiresAt: Date.now() + (body.expiresIn ?? 600) * 1000 };
}

async function refresh(config: FlabsConfig, current: Session): Promise<Session> {
  const { status, body } = await call(config, "/client/auth/token/refresh", {
    method: "POST",
    body: JSON.stringify({ clientID: config.clientId, refreshToken: current.refreshToken })
  });
  if (status !== 200 || !body.authToken) return login(config); // refresh expired after 30 idle days: log in again
  return { authToken: body.authToken, refreshToken: body.refreshToken, expiresAt: Date.now() + (body.expiresIn ?? 600) * 1000 };
}

async function getSession(config: FlabsConfig): Promise<Session> {
  const key = sessionKey(config);
  const current = sessions.get(key);
  const next = !current ? await login(config)
    : current.expiresAt - EXPIRY_MARGIN_MS <= Date.now() ? await refresh(config, current)
    : current;
  sessions.set(key, next);
  return next;
}

/** Authenticated request. A 401 means the token went stale: log in once more and retry. */
async function authed(config: FlabsConfig, path: string, init: RequestInit = {}) {
  const attempt = async () => {
    const s = await getSession(config);
    return call(config, path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${s.authToken}` } });
  };
  let result = await attempt();
  if (result.status === 401) {
    sessions.delete(sessionKey(config));
    result = await attempt();
  }
  return result;
}

export function describeFlabsError(status: number, body: any) {
  return body?.error?.details || body?.message || `Flabs responded with HTTP ${status}.`;
}

/** Corporate and referral accounts see their own prices: the tests and packages lists are filtered by party. */
function partyQuery(party?: FlabsParty) {
  if (!party) return "";
  const key = party.field === "corporateUser" ? "corporateUser" : "organization";
  return `&${key}=${encodeURIComponent(party.id)}`;
}

/** Some Flabs integrations list tests only for a corporate or organization. Pre-bookings do not need one. */
export const PARTY_REQUIRED_PATTERN = /corporateUser or organization is required/i;
export const PARTY_REQUIRED_HINT =
  "Flabs lists tests for this account only with a corporate/organization, so tests cannot be synced or mapped here. " +
  "Pre-bookings do not need a corporate: tests go to Flabs by name (unmapped_tests).";

function catalogError(status: number, body: any) {
  const message = describeFlabsError(status, body);
  return new FlabsError(status, PARTY_REQUIRED_PATTERN.test(String(message)) ? PARTY_REQUIRED_HINT : message);
}

/** Tests with prices for this account's party, or for another party (e.g. one corporate) when given. */
export type FlabsTest = { _id: string; name: string; code: string; cost: number };

export async function listTests(config: FlabsConfig, branchID: string, partyOverride?: FlabsParty) {
  const { status, body } = await authed(config, `/client/crm/tests?branchID=${encodeURIComponent(branchID)}${partyQuery(partyOverride ?? config.party)}`);
  if (status !== 200) throw catalogError(status, body);
  return (body.tests ?? []) as FlabsTest[];
}

export async function listPackages(config: FlabsConfig, branchID: string) {
  const { status, body } = await authed(config, `/client/crm/packages?branchID=${encodeURIComponent(branchID)}${partyQuery(config.party)}`);
  if (status !== 200) throw catalogError(status, body);
  return (body.packages ?? []) as Array<{ _id: string; name: string; code: string; total: number }>;
}

/** Active corporates of a branch (GET /client/crm/corporates). Each _id is sent as corporateUser. */
export async function listCorporates(config: FlabsConfig, branchID: string) {
  const { status, body } = await authed(config, `/client/crm/corporates?branchID=${encodeURIComponent(branchID)}`);
  if (status !== 200) throw new FlabsError(status, describeFlabsError(status, body));
  return ((body.corporates ?? []) as Array<{ _id: string; name: string }>).map(c => ({ id: String(c._id), name: String(c.name ?? "") }));
}

/**
 * Checks credentials before anything is saved: logs in and lists branches with a
 * throwaway session, so no saved session is touched.
 */
export async function testFlabsConnection(input: { clientId: string; clientSecret: string; baseUrl: string }) {
  const config = { ...input };
  const login = await call(config, "/client/auth/token", {
    method: "POST",
    body: JSON.stringify({ clientID: config.clientId, clientSecret: config.clientSecret })
  });
  if (login.status !== 200 || !login.body.authToken) {
    throw new FlabsError(login.status, login.body.message || login.body.error?.details || "Client ID or Client Secret is incorrect.");
  }
  const branches = await call(config, "/client/labs", { headers: { Authorization: `Bearer ${login.body.authToken}` } });
  if (branches.status !== 200) throw new FlabsError(branches.status, describeFlabsError(branches.status, branches.body));
  return (branches.body.branches ?? []) as Array<{ branchID: string; name: string; contact?: string }>;
}

export type CreateLeadPayload = Record<string, unknown>;

/** Returns the Flabs leadId on 201. A 409 is reported as duplicate so the caller can treat it as already synced. */
export async function createLead(config: FlabsConfig, payload: CreateLeadPayload) {
  const body = config.party ? { ...payload, [config.party.field]: config.party.id } : payload;
  const { status, body: response } = await authed(config, "/client/crm/lead/create", { method: "POST", body: JSON.stringify(body) });
  if (status === 201 || status === 200) return { duplicate: false, leadId: response.leadId as string | undefined };
  if (status === 409) return { duplicate: true, leadId: undefined };
  throw new FlabsError(status, describeFlabsError(status, response));
}

export type CreatePreBookingPayload = Record<string, unknown>;

/**
 * Creates a pre-booking (POST /client/billing/create), which starts Flabs' billing workflow.
 * Returns the Flabs preBookingID on 201. Barcode clashes and bad data come back as 4xx and are thrown.
 */
export async function createPreBooking(config: FlabsConfig, payload: CreatePreBookingPayload) {
  const { status, body } = await authed(config, "/client/billing/create", { method: "POST", body: JSON.stringify(payload) });
  if (status === 201 || status === 200) {
    return { preBookingID: body.preBookingID as string | undefined, integratorId: body.integrator_id as string | undefined, message: body.message as string | undefined };
  }
  throw new FlabsError(status, describeFlabsError(status, body));
}

/** Party query for webhook calls: the same rule as tests, but as a plain object. */
function partyFields(party?: FlabsParty): Record<string, string> {
  if (!party) return {};
  return party.field === "corporateUser" ? { corporateUser: party.id } : { organization: party.id };
}

/** Subscribes Flabs events to our endpoint for this account (or its party). */
export async function subscribeWebhook(config: FlabsConfig, input: { labID: string; events: string[]; endpoint: string }) {
  const body = { labID: input.labID, events: input.events, endpoint: input.endpoint, protocol: "https", ...partyFields(config.party) };
  const { status, body: response } = await authed(config, "/client/events/subscribe", { method: "POST", body: JSON.stringify(body) });
  if (status !== 200) throw new FlabsError(status, describeFlabsError(status, response));
  return response as { success: boolean; message: string };
}

export async function listWebhooks(config: FlabsConfig, labID: string) {
  const query = new URLSearchParams({ labID, ...partyFields(config.party) }).toString();
  const { status, body } = await authed(config, `/client/events/getAllEvents?${query}`);
  if (status !== 200) throw new FlabsError(status, describeFlabsError(status, body));
  return (body.data ?? []) as Array<{ _id: string; events: string[]; createdAt: string; updatedAt: string; corporateUser?: string; organization?: string }>;
}

export async function deleteWebhook(config: FlabsConfig, labID: string, webhookId: string) {
  const query = new URLSearchParams({ labID, ...partyFields(config.party) }).toString();
  const { status, body } = await authed(config, `/client/events/deleteEvent/${encodeURIComponent(webhookId)}?${query}`, { method: "DELETE" });
  if (status !== 200) throw new FlabsError(status, describeFlabsError(status, body));
  return body as { success: boolean; message: string };
}
