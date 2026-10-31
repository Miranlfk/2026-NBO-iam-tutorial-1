import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import QRCode from "qrcode";
import { config } from "./config.js";
import {
  describeTraveller,
  pollDeviceToken,
  refreshTokens,
  revokeToken,
  startDeviceFlow,
  type TokenSet
} from "./oauth.js";
import { destroySession, getOrCreateSession, getSession, type ScreenSession } from "./session.js";
import { errorPage, pendingPage, travellerPage, welcomePage } from "./views.js";
import { fetchNextTrip, type NextTrip } from "./wayfinder.js";

const app = express();
const publicDir = fileURLToPath(new URL("../public", import.meta.url));

// Caddy terminates TLS in front of us; trust its X-Forwarded-Proto so cookies get Secure.
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use((_request, response, next) => {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  next();
});

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.use(express.static(publicDir, { index: false, maxAge: "1h" }));

function log(message: string): void {
  console.log(`[screen] ${message}`);
}

// Returns a usable token set, refreshing it if it is about to expire.
async function freshTokens(session: ScreenSession): Promise<TokenSet | null> {
  const tokens = session.tokens;

  if (!tokens) {
    return null;
  }

  if (tokens.expiresAt - 30_000 > Date.now()) {
    return tokens;
  }

  const refreshed = tokens.refreshToken ? await refreshTokens(tokens.refreshToken) : null;

  if (!refreshed) {
    delete session.tokens;
    delete session.traveller;
    session.notice = "Your session expired. Sign in again.";
    return null;
  }

  session.tokens = refreshed;
  return refreshed;
}

app.get("/", async (request, response) => {
  const session = getSession(request);
  const tokens = session ? await freshTokens(session) : null;

  if (session && tokens && session.traveller) {
    let trip: { next?: NextTrip; error?: string };

    try {
      trip = { next: await fetchNextTrip(tokens.accessToken, session.traveller) };
    } catch (error) {
      trip = { error: (error as Error).message };
      log(`could not load trips for ${session.traveller.username}: ${trip.error}`);
    }

    response.send(travellerPage(session.traveller, tokens, trip));
    return;
  }

  const flow = session?.device;

  if (flow && flow.expiresAt > Date.now()) {
    const qrSvg = await QRCode.toString(flow.verificationUriComplete || flow.verificationUri, {
      type: "svg",
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#0b1736", light: "#ffffff" }
    });

    response.send(pendingPage(flow, qrSvg));
    return;
  }

  const notice = session?.notice;

  if (session) {
    delete session.device;
    delete session.notice;
  }

  response.send(welcomePage(notice));
});

app.post("/signin", async (request, response) => {
  const session = getOrCreateSession(request, response);

  try {
    session.device = await startDeviceFlow();
    log(`device flow started, user code ${session.device.userCode}`);
    response.redirect(303, "/");
  } catch (error) {
    log((error as Error).message);
    response.status(502).send(errorPage((error as Error).message));
  }
});

// Called by the page every `interval` seconds. The server enforces the
// interval itself, so extra tabs or reloads never make it poll faster.
app.post("/poll", async (request, response) => {
  const session = getSession(request);
  const flow = session?.device;

  if (!session || !flow) {
    response.json({ status: session?.tokens ? "approved" : "expired" });
    return;
  }

  if (Date.now() >= flow.expiresAt) {
    delete session.device;
    session.notice = "The sign-in code expired. Start again.";
    response.json({ status: "expired" });
    return;
  }

  if (flow.polling || Date.now() < flow.nextPollAt) {
    response.json({ status: "pending", retryAfter: Math.max(1, Math.ceil((flow.nextPollAt - Date.now()) / 1000)) });
    return;
  }

  flow.polling = true;

  try {
    const outcome = await pollDeviceToken(flow.deviceCode);

    switch (outcome.status) {
      case "approved":
        delete session.device;
        session.tokens = outcome.tokens;
        session.traveller = await describeTraveller(outcome.tokens);
        log(`signed in ${session.traveller.username}`);
        break;
      case "denied":
        delete session.device;
        session.notice = "Sign-in was declined on the phone.";
        break;
      case "expired":
        delete session.device;
        session.notice = "The sign-in code expired. Start again.";
        break;
      case "error":
        delete session.device;
        session.notice = outcome.message;
        log(outcome.message);
        break;
      case "slow_down":
        // RFC 8628 section 3.5: add 5 seconds to the interval for this and all later requests.
        flow.intervalSeconds += 5;
        log(`slow_down received, polling every ${flow.intervalSeconds}s`);
        break;
      case "pending":
        break;
    }

    flow.nextPollAt = Date.now() + flow.intervalSeconds * 1000;
    response.json({ status: outcome.status, retryAfter: flow.intervalSeconds });
  } catch (error) {
    if (session.device) {
      // A network error before the token response: keep the flow and try again later.
      flow.nextPollAt = Date.now() + flow.intervalSeconds * 1000;
      response.json({ status: "pending", retryAfter: flow.intervalSeconds });
    } else {
      // Tokens were issued but the traveller could not be read.
      delete session.tokens;
      session.notice = `Signed in, but the profile could not be read: ${(error as Error).message}`;
      response.json({ status: "error" });
    }

    log(`poll failed: ${(error as Error).message}`);
  } finally {
    flow.polling = false;
  }
});

app.post("/cancel", (request, response) => {
  const session = getSession(request);

  if (session) {
    delete session.device;
  }

  response.redirect(303, "/");
});

app.post("/signout", async (request, response) => {
  const session = getSession(request);
  const tokens = session?.tokens;

  if (tokens) {
    // Best effort: the screen forgets the tokens whether or not revocation succeeds.
    await Promise.allSettled([
      revokeToken(tokens.accessToken, "access_token"),
      ...(tokens.refreshToken ? [revokeToken(tokens.refreshToken, "refresh_token")] : [])
    ]);
    log(`signed out ${session?.traveller?.username || "traveller"}`);
  }

  destroySession(request, response);
  response.redirect(303, "/");
});

app.use((_request, response) => {
  response.status(404).json({ error: "Not found" });
});

app.use((error: Error, request: Request, response: Response, _next: NextFunction) => {
  log(`error on ${request.method} ${request.path}: ${error.message}`);

  if (request.path === "/poll") {
    response.status(500).json({ status: "error" });
  } else {
    response.status(500).send(errorPage(error.message));
  }
});

app.listen(config.port, () => {
  log(`listening on :${config.port}; Asgardeo client ${config.clientId}; Wayfinder API ${config.wayfinderApiUrl}`);
});
