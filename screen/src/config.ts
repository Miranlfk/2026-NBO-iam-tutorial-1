// Runtime configuration, read once from the environment. Nothing about the
// identity provider or the API is baked into the image.

function required(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required (see .env.example)`);
  }

  return value;
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function wayfinderApiUrl(): string {
  const explicit = process.env.WAYFINDER_API_URL?.trim();

  if (explicit) {
    return withoutTrailingSlash(explicit);
  }

  const appsDomain = process.env.APPS_DOMAIN?.trim();

  if (appsDomain) {
    return `https://api.${appsDomain}`;
  }

  throw new Error("Set WAYFINDER_API_URL, or APPS_DOMAIN to use https://api.<APPS_DOMAIN>");
}

const asgardeoBaseUrl = withoutTrailingSlash(required("ASGARDEO_BASE_URL"));

export const config = {
  port: Number(process.env.PORT || 8791),
  clientId: required("ASGARDEO_CLIENT_ID"),
  // Empty for a public client. When set, it is sent as client_secret_post.
  clientSecret: process.env.ASGARDEO_CLIENT_SECRET?.trim() || "",
  scopes: process.env.ASGARDEO_SCOPES?.trim() || "openid profile email bookings:read",
  // Optional RFC 8707 resource indicator (the WayFinder API identifier).
  resource: process.env.ASGARDEO_RESOURCE?.trim() || "",
  endpoints: {
    deviceAuthorization: `${asgardeoBaseUrl}/oauth2/device_authorize`,
    token: `${asgardeoBaseUrl}/oauth2/token`,
    userInfo: `${asgardeoBaseUrl}/oauth2/userinfo`,
    revocation: `${asgardeoBaseUrl}/oauth2/revoke`
  },
  wayfinderApiUrl: wayfinderApiUrl()
};
