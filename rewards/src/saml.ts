// SAML 2.0 service provider built on @node-saml/node-saml (the SAML engine
// behind @node-saml/passport-saml, used here without Passport because the
// back-channel logout has no browser session for Passport to work with).

import { DOMParser, type Element } from "@xmldom/xmldom";
import { SAML, ValidateInResponseTo, type IdpCertCallback, type Profile } from "@node-saml/node-saml";
import { config } from "./config.js";

const NS = {
  metadata: "urn:oasis:names:tc:SAML:2.0:metadata",
  assertion: "urn:oasis:names:tc:SAML:2.0:assertion",
  protocol: "urn:oasis:names:tc:SAML:2.0:protocol",
  dsig: "http://www.w3.org/2000/09/xmldsig#"
};
const METADATA_TTL_MS = 60 * 60 * 1000;

let metadataCerts: { certs: string[]; fetchedAt: number } | null = null;

// IdP signing certificates from SAML_IDP_METADATA_URL, cached for an hour; a
// stale copy is used if the IdP is briefly unreachable.
async function certsFromMetadata(): Promise<string[]> {
  if (metadataCerts && Date.now() - metadataCerts.fetchedAt < METADATA_TTL_MS) {
    return metadataCerts.certs;
  }

  try {
    const response = await fetch(config.idp.metadataUrl, { signal: AbortSignal.timeout(10_000) });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const doc = new DOMParser().parseFromString(await response.text(), "text/xml");
    const certs = Array.from(doc.getElementsByTagNameNS(NS.metadata, "KeyDescriptor"))
      .filter((keyDescriptor) => keyDescriptor.getAttribute("use") !== "encryption")
      .flatMap((keyDescriptor) => Array.from(keyDescriptor.getElementsByTagNameNS(NS.dsig, "X509Certificate")))
      .map((node) => (node.textContent || "").replace(/\s+/g, ""))
      .filter(Boolean);

    if (certs.length === 0) {
      throw new Error("no signing certificate in the metadata");
    }

    metadataCerts = { certs, fetchedAt: Date.now() };
    return certs;
  } catch (error) {
    if (metadataCerts) {
      console.warn(`[rewards] IdP metadata refresh failed, using the cached certificate: ${(error as Error).message}`);
      return metadataCerts.certs;
    }

    throw new Error(`Could not load IdP metadata from ${config.idp.metadataUrl}: ${(error as Error).message}`);
  }
}

const idpCertFromMetadata: IdpCertCallback = (callback) => {
  certsFromMetadata().then(
    (certs) => callback(null, certs),
    (error: Error) => callback(error)
  );
};

const signing = config.sp.privateKey
  ? { privateKey: config.sp.privateKey, publicCert: config.sp.cert || undefined }
  : {};

const attr = config.attributes;

export const saml = new SAML({
  issuer: config.sp.entityId,
  audience: config.sp.entityId,
  callbackUrl: config.sp.acsUrl,
  logoutCallbackUrl: config.sp.sloUrl,
  entryPoint: config.idp.ssoUrl,
  logoutUrl: config.idp.sloUrl,
  idpCert: config.idp.cert || idpCertFromMetadata,
  idpIssuer: config.idp.entityId || undefined,
  identifierFormat: config.sp.nameIdFormat || null,
  wantAuthnResponseSigned: config.wantResponseSigned,
  wantAssertionsSigned: config.wantAssertionsSigned,
  // Responses to our own AuthnRequests must match one we sent; IdP-initiated
  // (unsolicited) responses carry no InResponseTo and are still accepted.
  validateInResponseTo: ValidateInResponseTo.ifPresent,
  rejectReplayedAssertions: true,
  acceptedClockSkewMs: 60_000,
  // Let the IdP choose the authenticator (passkey, password, ...).
  disableRequestedAuthnContext: true,
  signatureAlgorithm: "sha256",
  ...signing,
  // Informational: what Rewards asks for. Phone is optional (W8).
  metadataAttributeConsumingServices: [
    {
      "@index": "1",
      "@isDefault": true,
      ServiceName: [{ "@xml:lang": "en", "#text": "Wayfinder Rewards" }],
      RequestedAttribute: [
        { "@Name": attr.firstName, "@FriendlyName": "First Name", "@isRequired": true },
        { "@Name": attr.lastName, "@FriendlyName": "Last Name", "@isRequired": true },
        { "@Name": attr.email, "@FriendlyName": "Email", "@isRequired": true },
        { "@Name": attr.loyaltyTier, "@FriendlyName": "Loyalty Tier", "@isRequired": true },
        { "@Name": attr.loyaltyPoints, "@FriendlyName": "Loyalty Points", "@isRequired": true },
        { "@Name": attr.phone, "@FriendlyName": "Mobile", "@isRequired": false }
      ]
    }
  ]
});

export function spMetadata(): string {
  return saml.generateServiceProviderMetadata(null, config.sp.cert || null);
}

// Attribute values as string arrays, whatever shape the assertion used.
export function profileAttributes(profile: Profile): Record<string, string[]> {
  const raw = (profile.attributes ?? {}) as Record<string, unknown>;

  return Object.fromEntries(
    Object.entries(raw).map(([name, value]) => [
      name,
      (Array.isArray(value) ? value : [value]).map((item) =>
        typeof item === "object" && item !== null && "_" in item ? String((item as { _: unknown })._) : String(item ?? "")
      )
    ])
  );
}

export interface LogoutInstruction {
  nameID: string;
  sessionIndex?: string;
  issuer?: string;
  signed: boolean;
}

function childText(root: Element, namespace: string, localName: string): string {
  const node = Array.from(root.childNodes).find(
    (child) => child.namespaceURI === namespace && child.localName === localName
  );

  return node?.textContent?.trim() || "";
}

// Reads a LogoutRequest that arrived with the HTTP-POST binding (Asgardeo's
// back-channel logout posts SAMLRequest=<base64 XML> server to server).
// Signed requests are always verified by node-saml. Unsigned ones are refused
// unless SAML_SLO_REQUIRE_SIGNATURE=false, and then the issuer and expiry are
// still checked.
export async function readLogoutRequest(samlRequest: string): Promise<LogoutInstruction> {
  const xml = Buffer.from(samlRequest, "base64").toString("utf8");
  const root = new DOMParser().parseFromString(xml, "text/xml").documentElement;

  if (!root || root.localName !== "LogoutRequest" || root.namespaceURI !== NS.protocol) {
    throw new Error("SAMLRequest is not a LogoutRequest");
  }

  const isSigned = Array.from(root.childNodes).some(
    (child) => child.namespaceURI === NS.dsig && child.localName === "Signature"
  );

  if (isSigned || config.sloRequireSignature) {
    const { profile } = await saml.validatePostRequestAsync({ SAMLRequest: samlRequest });

    return { nameID: profile.nameID, sessionIndex: profile.sessionIndex, issuer: profile.issuer, signed: true };
  }

  const issuer = childText(root, NS.assertion, "Issuer");
  const notOnOrAfter = root.getAttribute("NotOnOrAfter");
  const nameID = childText(root, NS.assertion, "NameID");

  if (config.idp.entityId && issuer !== config.idp.entityId) {
    throw new Error(`Unknown LogoutRequest issuer: ${issuer}`);
  }

  if (notOnOrAfter && Date.parse(notOnOrAfter) + 60_000 < Date.now()) {
    throw new Error("LogoutRequest has expired");
  }

  if (!nameID) {
    throw new Error("LogoutRequest has no NameID");
  }

  return { nameID, sessionIndex: childText(root, NS.protocol, "SessionIndex") || undefined, issuer, signed: false };
}
