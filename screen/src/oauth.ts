// OAuth 2.0 device authorization grant (RFC 8628) against Asgardeo, done
// server-side so the client id and endpoints come from the environment and
// the browser never talks to the identity provider or sees a token.

import { config } from "./config.js";

export interface DeviceFlow {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  intervalSeconds: number;
  nextPollAt: number;
  polling: boolean;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  scope?: string;
  expiresAt: number;
}

export interface Traveller {
  sub: string;
  displayName: string;
  // The value the Wayfinder SPA sends as X-Wayfinder-Username; bookings are
  // stored under it, so the screen must send the same one.
  username: string;
  email?: string;
}

export type PollOutcome =
  | { status: "pending" | "slow_down" }
  | { status: "approved"; tokens: TokenSet }
  | { status: "denied" | "expired" }
  | { status: "error"; message: string };

type Json = Record<string, unknown>;

const DEFAULT_INTERVAL_SECONDS = 5;
const TIMEOUT_MS = 10_000;

function clientParams(): Record<string, string> {
  return config.clientSecret
    ? { client_id: config.clientId, client_secret: config.clientSecret }
    : { client_id: config.clientId };
}

async function postForm(url: string, params: Record<string, string>): Promise<{ status: number; body: Json }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const body = (await response.json().catch(() => ({}))) as Json;

  return { status: response.status, body };
}

function errorText(body: Json, fallback: string): string {
  return String(body.error_description || body.error || fallback);
}

function toTokenSet(body: Json): TokenSet {
  return {
    accessToken: String(body.access_token),
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    idToken: typeof body.id_token === "string" ? body.id_token : undefined,
    scope: typeof body.scope === "string" ? body.scope : undefined,
    expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000
  };
}

export async function startDeviceFlow(): Promise<DeviceFlow> {
  const params: Record<string, string> = { ...clientParams(), scope: config.scopes };

  if (config.resource) {
    params.resource = config.resource;
  }

  const { status, body } = await postForm(config.endpoints.deviceAuthorization, params);

  if (status !== 200 || typeof body.device_code !== "string" || typeof body.user_code !== "string") {
    throw new Error(`Device authorization failed (${status}): ${errorText(body, "no device_code in the response")}`);
  }

  const intervalSeconds = Number(body.interval || DEFAULT_INTERVAL_SECONDS);

  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: String(body.verification_uri || body.verification_url || ""),
    verificationUriComplete:
      typeof body.verification_uri_complete === "string" ? body.verification_uri_complete : undefined,
    expiresAt: Date.now() + Number(body.expires_in || 600) * 1000,
    intervalSeconds,
    nextPollAt: Date.now() + intervalSeconds * 1000,
    polling: false
  };
}

// One token request. The caller is responsible for honouring the interval.
export async function pollDeviceToken(deviceCode: string): Promise<PollOutcome> {
  const { status, body } = await postForm(config.endpoints.token, {
    ...clientParams(),
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: deviceCode
  });

  if (status === 200 && typeof body.access_token === "string") {
    return { status: "approved", tokens: toTokenSet(body) };
  }

  switch (body.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down" };
    case "access_denied":
      return { status: "denied" };
    case "expired_token":
      return { status: "expired" };
    default:
      return { status: "error", message: `Token request failed (${status}): ${errorText(body, "unknown error")}` };
  }
}

export async function refreshTokens(refreshToken: string): Promise<TokenSet | null> {
  const { status, body } = await postForm(config.endpoints.token, {
    ...clientParams(),
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });

  if (status !== 200 || typeof body.access_token !== "string") {
    return null;
  }

  return { refreshToken, ...toTokenSet(body) };
}

export async function revokeToken(token: string, hint: "access_token" | "refresh_token"): Promise<void> {
  const { status, body } = await postForm(config.endpoints.revocation, {
    ...clientParams(),
    token,
    token_type_hint: hint
  });

  if (status !== 200) {
    console.warn(`[screen] token revocation returned ${status}: ${errorText(body, "no detail")}`);
  }
}

function decodeJwtPayload(jwt: string): Json {
  const payload = jwt.split(".")[1] || "";

  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Json;
}

async function fetchUserInfo(accessToken: string): Promise<Json> {
  const response = await fetch(config.endpoints.userInfo, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`UserInfo request failed (${response.status})`);
  }

  return (await response.json()) as Json;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// The ID token came straight from the token endpoint over TLS, so it is not
// re-verified here (OpenID Connect Core 3.1.3.7, item 6). Without one, fall
// back to the UserInfo endpoint.
export async function describeTraveller(tokens: TokenSet): Promise<Traveller> {
  const claims = tokens.idToken ? decodeJwtPayload(tokens.idToken) : await fetchUserInfo(tokens.accessToken);
  const sub = text(claims.sub);
  const email = text(claims.email) || undefined;
  const username = text(claims.username) || text(claims.preferred_username) || email || sub;
  const fullName = [text(claims.given_name), text(claims.family_name)].filter(Boolean).join(" ");

  return {
    sub,
    displayName: text(claims.name) || fullName || username,
    username,
    email
  };
}
