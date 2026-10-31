import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Profile } from "@node-saml/node-saml";
import { config } from "./config.js";
import { profileAttributes, readLogoutRequest, saml, spMetadata } from "./saml.js";
import {
  activeSessionCount,
  createSession,
  currentSession,
  endCurrentSession,
  endSessionsFor,
  takeEndedNotice
} from "./sessions.js";
import { errorPage, homePage, memberPage } from "./views.js";

const app = express();
const publicDir = fileURLToPath(new URL("../public", import.meta.url));
const samlForm = express.urlencoded({ extended: false, limit: "512kb" });

// Caddy terminates TLS in front of us; trust its X-Forwarded-Proto so cookies get Secure.
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use((_request, response, next) => {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; script-src 'none'; frame-ancestors 'none'; base-uri 'none'"
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  next();
});

function log(message: string): void {
  console.log(`[rewards] ${message}`);
}

function safeReturnPath(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/";
}

function rawQuery(request: Request): string {
  return request.originalUrl.split("?")[1] || "";
}

app.get("/health", (_request, response) => {
  response.json({ status: "ok", sessions: activeSessionCount() });
});

app.use(express.static(publicDir, { index: false, maxAge: "1h" }));

app.get("/", (request, response) => {
  const session = currentSession(request);

  if (session) {
    response.send(memberPage(session));
    return;
  }

  response.send(homePage({ ended: takeEndedNotice(request, response), signedOut: request.query.signedout === "1" }));
});

// SP metadata for registering Rewards in Asgardeo (or importing by URL).
app.get("/saml/metadata", (_request, response) => {
  response.type("application/samlmetadata+xml").send(spMetadata());
});

// SP-initiated sign-in: AuthnRequest over the HTTP-Redirect binding.
app.get("/login", async (request, response) => {
  const url = await saml.getAuthorizeUrlAsync(safeReturnPath(request.query.returnTo), {});

  response.redirect(302, url);
});

// Assertion consumer service (HTTP-POST binding).
app.post("/saml/acs", samlForm, async (request, response) => {
  const samlResponse = request.body?.SAMLResponse;

  if (typeof samlResponse !== "string") {
    response.status(400).send(errorPage("Sign-in failed", "No SAMLResponse in the request."));
    return;
  }

  try {
    const { profile } = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse });

    if (!profile) {
      throw new Error("The identity provider returned no assertion.");
    }

    const session = createSession(request, response, {
      nameID: profile.nameID,
      nameIDFormat: profile.nameIDFormat,
      nameQualifier: profile.nameQualifier,
      spNameQualifier: profile.spNameQualifier,
      sessionIndex: profile.sessionIndex,
      issuer: profile.issuer,
      attributes: profileAttributes(profile)
    });

    log(`signed in ${session.nameID} (SessionIndex ${session.sessionIndex || "none"}, ${Object.keys(session.attributes).length} attributes)`);
    response.redirect(303, safeReturnPath(request.body.RelayState));
  } catch (error) {
    log(`assertion rejected: ${(error as Error).message}`);
    response.status(401).send(errorPage("Sign-in failed", (error as Error).message));
  }
});

// Single logout endpoint.
// - POST SAMLRequest: a LogoutRequest from the IdP. Asgardeo's back-channel
//   logout posts it server to server, without the member's browser, so the
//   session is found by NameID + SessionIndex, never by cookie.
// - POST/GET SAMLResponse: the IdP's answer to our own LogoutRequest.
app.post("/saml/slo", samlForm, async (request, response) => {
  const { SAMLRequest, SAMLResponse } = request.body || {};

  if (typeof SAMLRequest === "string") {
    try {
      const logout = await readLogoutRequest(SAMLRequest);
      const ended = endSessionsFor(logout.nameID, logout.sessionIndex);

      log(
        `back-channel logout from ${logout.issuer || "IdP"} (${logout.signed ? "signed" : "unsigned"}): ` +
          `NameID ${logout.nameID}, SessionIndex ${logout.sessionIndex || "any"}, ended ${ended.length} session(s)`
      );
      response.status(200).type("text/plain").send(`Ended ${ended.length} session(s)`);
    } catch (error) {
      log(`LogoutRequest rejected: ${(error as Error).message}`);
      response.status(400).type("text/plain").send("Invalid LogoutRequest");
    }

    return;
  }

  if (typeof SAMLResponse === "string") {
    try {
      await saml.validatePostResponseAsync({ SAMLResponse });
      log("IdP confirmed the logout");
    } catch (error) {
      log(`LogoutResponse not verified: ${(error as Error).message}`);
    }

    response.redirect(303, "/?signedout=1");
    return;
  }

  response.status(400).type("text/plain").send("Expected SAMLRequest or SAMLResponse");
});

// HTTP-Redirect binding: the IdP's LogoutResponse, or a front-channel LogoutRequest.
app.get("/saml/slo", async (request, response) => {
  if (typeof request.query.SAMLResponse === "string") {
    try {
      await saml.validateRedirectAsync(rawQuery(request));
      log("IdP confirmed the logout");
    } catch (error) {
      log(`LogoutResponse not verified: ${(error as Error).message}`);
    }

    response.redirect(303, "/?signedout=1");
    return;
  }

  if (typeof request.query.SAMLRequest === "string") {
    try {
      const { profile, relayState } = await saml.validateRedirectAsync(rawQuery(request));

      if (!profile) {
        throw new Error("No LogoutRequest in the message");
      }

      const ended = endSessionsFor(profile.nameID, profile.sessionIndex);

      log(`front-channel logout: NameID ${profile.nameID}, ended ${ended.length} session(s)`);
      endCurrentSession(request, response);
      response.redirect(303, await saml.getLogoutResponseUrlAsync(profile, relayState || "", {}, true));
    } catch (error) {
      log(`LogoutRequest rejected: ${(error as Error).message}`);
      response.status(400).type("text/plain").send("Invalid LogoutRequest");
    }

    return;
  }

  response.redirect(303, "/");
});

// SP-initiated sign-out: end the local session, then ask the IdP to end the
// Wayfinder ID session too (and, through it, the other apps).
app.post("/logout", async (request, response) => {
  const session = endCurrentSession(request, response);

  if (!session) {
    response.redirect(303, "/");
    return;
  }

  const user: Profile = {
    issuer: session.issuer || "",
    nameID: session.nameID,
    nameIDFormat: session.nameIDFormat || "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
    nameQualifier: session.nameQualifier,
    spNameQualifier: session.spNameQualifier,
    sessionIndex: session.sessionIndex
  };

  log(`signed out ${session.nameID}; sending LogoutRequest to the IdP`);
  response.redirect(303, await saml.getLogoutUrlAsync(user, "/", {}));
});

app.use((_request, response) => {
  response.status(404).type("text/plain").send("Not found");
});

app.use((error: Error, request: Request, response: Response, _next: NextFunction) => {
  log(`error on ${request.method} ${request.path}: ${error.message}`);
  response.status(500).send(errorPage("Something went wrong", error.message));
});

app.listen(config.port, () => {
  log(`listening on :${config.port}; SP ${config.sp.entityId}; ACS ${config.sp.acsUrl}; SLO ${config.sp.sloUrl}`);
  log(`IdP SSO ${config.idp.ssoUrl}; certificate from ${config.idp.cert ? "SAML_IDP_CERT" : config.idp.metadataUrl}`);
});
