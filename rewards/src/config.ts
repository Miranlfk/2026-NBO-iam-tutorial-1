// Runtime configuration from the environment: SP and IdP settings are never
// baked into the image.

function env(name: string): string {
  return process.env[name]?.trim() || "";
}

function required(name: string): string {
  const value = env(name);

  if (!value) {
    throw new Error(`${name} is required (see .env.example)`);
  }

  return value;
}

function flag(name: string, fallback: boolean): boolean {
  const value = env(name).toLowerCase();

  return value ? value === "true" : fallback;
}

// PEM values in .env files often arrive on one line with literal "\n".
function pem(name: string): string {
  return env(name).replace(/\\n/g, "\n");
}

function publicUrl(): string {
  const explicit = env("PUBLIC_URL").replace(/\/+$/, "");

  if (explicit) {
    return explicit;
  }

  const appsDomain = env("APPS_DOMAIN");

  if (appsDomain) {
    return `https://rewards.${appsDomain}`;
  }

  throw new Error("Set PUBLIC_URL, or APPS_DOMAIN to use https://rewards.<APPS_DOMAIN>");
}

const baseUrl = publicUrl();
const idpSsoUrl = required("SAML_IDP_SSO_URL");
const idpCert = pem("SAML_IDP_CERT");
const idpMetadataUrl = env("SAML_IDP_METADATA_URL");

if (!idpCert && !idpMetadataUrl) {
  throw new Error("Set SAML_IDP_CERT or SAML_IDP_METADATA_URL so assertions can be verified");
}

export const config = {
  port: Number(env("PORT") || 8792),
  publicUrl: baseUrl,
  sp: {
    entityId: env("SAML_SP_ENTITY_ID") || "wayfinder-rewards",
    acsUrl: env("SAML_ACS_URL") || `${baseUrl}/saml/acs`,
    sloUrl: env("SAML_SLO_URL") || `${baseUrl}/saml/slo`,
    // Empty string: send no NameIDPolicy and accept what the IdP is configured for.
    nameIdFormat: process.env.SAML_NAMEID_FORMAT ?? "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    // Optional: sign AuthnRequests and LogoutRequests with this key pair.
    privateKey: pem("SAML_SP_PRIVATE_KEY"),
    cert: pem("SAML_SP_CERT")
  },
  idp: {
    ssoUrl: idpSsoUrl,
    sloUrl: env("SAML_IDP_SLO_URL") || idpSsoUrl,
    entityId: env("SAML_IDP_ENTITY_ID"),
    cert: idpCert,
    metadataUrl: idpMetadataUrl
  },
  wantResponseSigned: flag("SAML_WANT_RESPONSE_SIGNED", true),
  wantAssertionsSigned: flag("SAML_WANT_ASSERTIONS_SIGNED", false),
  sloRequireSignature: flag("SAML_SLO_REQUIRE_SIGNATURE", true),
  // Assertion attribute names. Asgardeo sends local claim URIs by default.
  attributes: {
    firstName: env("SAML_ATTR_FIRST_NAME") || "http://wso2.org/claims/givenname",
    lastName: env("SAML_ATTR_LAST_NAME") || "http://wso2.org/claims/lastname",
    email: env("SAML_ATTR_EMAIL") || "http://wso2.org/claims/emailaddress",
    phone: env("SAML_ATTR_PHONE") || "http://wso2.org/claims/mobile",
    loyaltyTier: env("SAML_ATTR_LOYALTY_TIER") || "http://wso2.org/claims/loyaltyTier",
    loyaltyPoints: env("SAML_ATTR_LOYALTY_POINTS") || "http://wso2.org/claims/loyaltyPoints"
  }
};
