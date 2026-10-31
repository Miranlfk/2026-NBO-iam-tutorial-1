/**
 * Application configuration.
 *
 * Each value is read from `window.__WAYFINDER_ENV__` first, which the container
 * writes to /env-config.js from its environment at start-up, so one image can
 * serve any domain and identity provider. When that is absent or empty (local
 * `npm run dev`), the build-time VITE_* value from .env applies. Variable names
 * are the same in both places.
 */
const runtimeEnv = (typeof window !== "undefined" && window.__WAYFINDER_ENV__) || {};

function read(runtimeValue, buildValue, fallback = "") {
  for (const value of [runtimeValue, buildValue]) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return fallback;
}

function getOrgNameFromBaseUrl(baseUrl) {
  if (!baseUrl) {
    return "";
  }

  try {
    const pathParts = new URL(baseUrl).pathname.split("/").filter(Boolean);
    const tenantIndex = pathParts.indexOf("t");

    return tenantIndex >= 0 ? pathParts[tenantIndex + 1] || "" : "";
  } catch {
    return "";
  }
}

/**
 * Asgardeo serves self sign-up from the accounts host paired with the API host
 * (api.<domain> -> accounts.<domain>) at /t/<org>/accounts/register.
 */
function deriveSignUpUrl(baseUrl, orgName) {
  try {
    const url = new URL(baseUrl);

    if (!url.hostname.startsWith("api.")) {
      return "";
    }

    url.hostname = `accounts.${url.hostname.slice("api.".length)}`;
    url.pathname = orgName ? `/t/${encodeURIComponent(orgName)}/accounts/register` : "/accounts/register";
    url.search = "";
    url.hash = "";

    return url.toString();
  } catch {
    return "";
  }
}

/**
 * My Account, the self-service portal, on the host paired with the API host
 * (api.<domain> -> myaccount.<domain>) at /t/<org>.
 */
function deriveMyAccountUrl(baseUrl, orgName) {
  try {
    const url = new URL(baseUrl);

    if (!url.hostname.startsWith("api.")) {
      return "";
    }

    url.hostname = `myaccount.${url.hostname.slice("api.".length)}`;
    url.pathname = orgName ? `/t/${encodeURIComponent(orgName)}/` : "/";
    url.search = "";
    url.hash = "";

    return url.toString();
  } catch {
    return "";
  }
}

export const ASGARDEO_CLIENT_ID = read(
  runtimeEnv.VITE_ASGARDEO_CLIENT_ID,
  import.meta.env.VITE_ASGARDEO_CLIENT_ID
);

// CDS keys `application_data` by the Asgardeo application ID, not the OAuth client ID.
export const ASGARDEO_APPLICATION_ID = read(
  runtimeEnv.VITE_ASGARDEO_APPLICATION_ID,
  import.meta.env.VITE_ASGARDEO_APPLICATION_ID
);

export const ASGARDEO_BASE_URL = read(
  runtimeEnv.VITE_ASGARDEO_BASE_URL,
  import.meta.env.VITE_ASGARDEO_BASE_URL
).replace(/\/+$/, "");

export const ASGARDEO_ORG_NAME = read(
  runtimeEnv.VITE_ASGARDEO_ORG_NAME,
  import.meta.env.VITE_ASGARDEO_ORG_NAME,
  getOrgNameFromBaseUrl(ASGARDEO_BASE_URL)
);

export const ASGARDEO_SIGN_UP_URL = read(
  runtimeEnv.VITE_ASGARDEO_SIGN_UP_URL,
  import.meta.env.VITE_ASGARDEO_SIGN_UP_URL,
  deriveSignUpUrl(ASGARDEO_BASE_URL, ASGARDEO_ORG_NAME)
);

// Scopes requested at sign-in, space- or comma-separated. The SDK adds
// openid, profile and internal_login itself.
export const ASGARDEO_SCOPES = read(
  runtimeEnv.VITE_ASGARDEO_SCOPES,
  import.meta.env.VITE_ASGARDEO_SCOPES,
  "bookings:read bookings:write deal-alert-consents:write"
).split(/[\s,]+/).filter(Boolean);

export const API_BASE_URL = read(
  runtimeEnv.VITE_API_BASE_URL,
  import.meta.env.VITE_API_BASE_URL,
  "http://localhost:8787"
).replace(/\/+$/, "");

export const AGENT_API_BASE_URL = read(
  runtimeEnv.VITE_AGENT_API_BASE_URL,
  import.meta.env.VITE_AGENT_API_BASE_URL
).replace(/\/+$/, "");

export const WALLET_CREDENTIAL_OFFER = read(
  runtimeEnv.VITE_WALLET_CREDENTIAL_OFFER,
  import.meta.env.VITE_WALLET_CREDENTIAL_OFFER
);

export const MY_ACCOUNT_URL = read(
  runtimeEnv.VITE_MY_ACCOUNT_URL,
  import.meta.env.VITE_MY_ACCOUNT_URL,
  deriveMyAccountUrl(ASGARDEO_BASE_URL, ASGARDEO_ORG_NAME)
);

// Step-up re-authentication: the acr_values the Wayfinder login flow acts on.
// "Verify with face" asks for STEP_UP_ACR_FACE; a payment above
// HIGH_VALUE_FARE_LIMIT (total, in the fare's currency; 0 turns it off) asks
// for STEP_UP_ACR_HIGH_VALUE before it goes through.
export const STEP_UP_ACR_FACE = read(
  runtimeEnv.VITE_STEP_UP_ACR_FACE,
  import.meta.env.VITE_STEP_UP_ACR_FACE,
  "face"
);

export const STEP_UP_ACR_HIGH_VALUE = read(
  runtimeEnv.VITE_STEP_UP_ACR_HIGH_VALUE,
  import.meta.env.VITE_STEP_UP_ACR_HIGH_VALUE,
  "high-value"
);

export const HIGH_VALUE_FARE_LIMIT = Number.parseFloat(read(
  runtimeEnv.VITE_HIGH_VALUE_FARE_LIMIT,
  import.meta.env.VITE_HIGH_VALUE_FARE_LIMIT,
  "1000"
)) || 0;

// Extra sign-in options: the names of the identity provider's connections for
// wallet sign-in (OpenID4VP) and Sign-In with Ethereum. Each one set adds a
// button that starts sign-in straight at that connection (fidp); empty hides it.
export const WALLET_SIGN_IN_CONNECTION = read(
  runtimeEnv.VITE_WALLET_SIGN_IN_CONNECTION,
  import.meta.env.VITE_WALLET_SIGN_IN_CONNECTION
);

export const SIWE_SIGN_IN_CONNECTION = read(
  runtimeEnv.VITE_SIWE_SIGN_IN_CONNECTION,
  import.meta.env.VITE_SIWE_SIGN_IN_CONNECTION
);
