// Server-rendered pages. Every interpolated value goes through esc().

import type { DeviceFlow, TokenSet, Traveller } from "./oauth.js";
import type { NextTrip } from "./wayfinder.js";

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Changes on every start, so a redeploy never leaves stale CSS or JS in a browser cache.
const ASSET_VERSION = Date.now().toString(36);

const PLANE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg>';

function layout(state: string, main: string, data: Record<string, string | number> = {}): string {
  const dataAttributes = Object.entries(data)
    .map(([key, value]) => ` data-${key}="${esc(value)}"`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0b1736">
  <title>Wayfinder in-flight</title>
  <link rel="icon" type="image/png" href="/wayfinder-logo.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">
  <link rel="stylesheet" href="/styles.css?v=${ASSET_VERSION}">
  <script src="/screen.js?v=${ASSET_VERSION}" defer></script>
</head>
<body data-state="${esc(state)}"${dataAttributes}>
  <header class="bar">
    <div class="brand"><img src="/wayfinder-logo.png" alt="" width="40" height="40"><span>Wayfinder</span></div>
    <div class="bar-meta"><span>In-flight</span><span id="clock" aria-label="Local time"></span></div>
  </header>
  <main class="stage">
${main}
  </main>
  <footer class="foot">Seat-back screen &middot; signs in with the OAuth 2.0 device authorization grant</footer>
</body>
</html>`;
}

function noticeBlock(notice?: string): string {
  return notice ? `<p class="notice" role="alert">${esc(notice)}</p>` : "";
}

export function welcomePage(notice?: string): string {
  return layout(
    "welcome",
    `    <section class="hero">
      <p class="eyebrow">Welcome aboard</p>
      <h1>Your trip, on this screen.</h1>
      <p class="lead">Sign in with your Wayfinder account from your phone. Nothing to type here.</p>
      <form method="post" action="/signin"><button class="cta" type="submit">Sign in</button></form>
      ${noticeBlock(notice)}
    </section>`
  );
}

function displayUri(uri: string): string {
  return uri.replace(/^https?:\/\//, "");
}

export function pendingPage(flow: DeviceFlow, qrSvg: string): string {
  return layout(
    "pending",
    `    <section class="pair">
      <div class="pair-steps">
        <p class="eyebrow">Sign in with your phone</p>
        <h1>Scan the code, or go to</h1>
        <p class="url">${esc(displayUri(flow.verificationUri))}</p>
        <p class="label">and enter this code</p>
        <p class="user-code" aria-label="User code">${esc(flow.userCode)}</p>
        <p class="status" id="status" role="status">Waiting for you to approve on your phone&hellip;</p>
        <p class="expiry">Code expires in <span id="countdown">--:--</span></p>
        <form method="post" action="/cancel"><button class="ghost" type="submit">Cancel</button></form>
      </div>
      <figure class="qr">
        ${qrSvg}
        <figcaption>Point your phone camera here</figcaption>
      </figure>
    </section>`,
    { "expires-at": flow.expiresAt, interval: flow.intervalSeconds }
  );
}

function tripCard(next: NextTrip): string {
  const booking = next.booking;

  if (!booking) {
    return `    <section class="trip trip--empty">
      <h2>No trips booked yet</h2>
      <p>Book your next journey at Wayfinder and it will show up here.</p>
    </section>`;
  }

  const { flight } = booking;
  const stops = flight.stops === 0 ? "Non-stop" : `${flight.stops} stop${flight.stops > 1 ? "s" : ""}`;
  const travellers = booking.travelers || 1;

  return `    <section class="trip">
      <div class="trip-head">
        <span class="pill">${next.upcoming ? "Next trip" : "Latest booking"}</span>
        <span class="dates">${esc(flight.dates)}</span>
      </div>
      <div class="route">
        <div class="end"><span class="city">${esc(flight.from)}</span><span class="time">${esc(flight.departureTime)}</span></div>
        <div class="path">${PLANE_ICON}<span>${esc(flight.duration)} &middot; ${esc(stops)}</span></div>
        <div class="end end--to"><span class="city">${esc(flight.to)}</span><span class="time">${esc(flight.arrivalTime)}</span></div>
      </div>
      <dl class="facts">
        <div><dt>Airline</dt><dd>${esc(flight.airline)}</dd></div>
        <div><dt>Cabin</dt><dd>${esc(flight.cabin)}</dd></div>
        <div><dt>Booking</dt><dd>${esc(booking.bookingReference || booking.id)}</dd></div>
        <div><dt>Travellers</dt><dd>${esc(travellers)}</dd></div>
      </dl>
      ${booking.bookedByAgentName ? `<p class="agent-note">Booked for you by ${esc(booking.bookedByAgentName)}</p>` : ""}
      ${next.activeCount > 1 ? `<p class="more">+ ${next.activeCount - 1} more booking${next.activeCount > 2 ? "s" : ""} in your Wayfinder account</p>` : ""}
    </section>`;
}

export function travellerPage(
  traveller: Traveller,
  tokens: TokenSet,
  trip: { next?: NextTrip; error?: string }
): string {
  const firstName = traveller.displayName.split(/\s+/)[0] || traveller.displayName;
  const tripBlock = trip.next
    ? tripCard(trip.next)
    : `    <section class="trip trip--empty">
      <h2>Your trip could not be loaded</h2>
      <p class="notice">${esc(trip.error)}</p>
    </section>`;

  return layout(
    "signed-in",
    `    <section class="greeting">
      <p class="eyebrow">Signed in</p>
      <h1>Welcome back, ${esc(firstName)}.</h1>
    </section>
${tripBlock}
    <aside class="session">
      <p>Signed in as <strong>${esc(traveller.username)}</strong> with the device authorization grant${
        tokens.scope ? ` &middot; scopes: <code>${esc(tokens.scope)}</code>` : ""
      }</p>
      <form method="post" action="/signout"><button class="ghost" type="submit">Sign out</button></form>
    </aside>`
  );
}

export function errorPage(message: string): string {
  return layout(
    "error",
    `    <section class="hero">
      <p class="eyebrow">Something went wrong</p>
      <h1>We could not start sign-in.</h1>
      <p class="notice" role="alert">${esc(message)}</p>
      <form method="get" action="/"><button class="cta" type="submit">Back</button></form>
    </section>`
  );
}
