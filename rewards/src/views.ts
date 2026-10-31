// Server-rendered pages for Wayfinder Rewards. Every interpolated value goes
// through esc().

import { config } from "./config.js";
import type { EndedSession, MemberSession } from "./sessions.js";

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Changes on every start, so a redeploy never leaves stale CSS in a browser cache.
const ASSET_VERSION = Date.now().toString(36);

function utcTime(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(11, 19)} UTC`;
}

interface Member {
  name: string;
  email?: string;
  phone?: string;
  tier?: string;
  points?: string;
}

function memberFrom(session: MemberSession): Member {
  const value = (name: string) => session.attributes[name]?.find((item) => item.trim())?.trim();
  const attr = config.attributes;
  const name = [value(attr.firstName), value(attr.lastName)].filter(Boolean).join(" ");
  const points = value(attr.loyaltyPoints);

  return {
    name: name || session.nameID,
    email: value(attr.email),
    phone: value(attr.phone),
    tier: value(attr.loyaltyTier),
    points: points && /^\d+$/.test(points) ? Number(points).toLocaleString("en-US") : points
  };
}

function layout(title: string, header: string, main: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#4c1d95">
  <title>${esc(title)}</title>
  <link rel="icon" type="image/svg+xml" href="/rewards-logo.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap">
  <link rel="stylesheet" href="/styles.css?v=${ASSET_VERSION}">
</head>
<body>
  <header class="top">
    <a class="brand" href="/"><img src="/rewards-logo.svg" alt="" width="40" height="40"><span>Wayfinder <em>Rewards</em></span></a>
    ${header}
  </header>
  <main class="page">
${main}
  </main>
  <footer class="foot">Wayfinder Rewards is a Wayfinder Travel brand &middot; Sign in with Wayfinder ID (SAML 2.0)</footer>
</body>
</html>`;
}

const SIGN_IN_BUTTON = '<a class="button button--gold" href="/login">Sign in with Wayfinder ID</a>';

export function homePage(notice?: { ended?: EndedSession; signedOut?: boolean }): string {
  let message = "";

  if (notice?.ended) {
    message = `<p class="notice notice--slo" role="status"><strong>You were signed out.</strong> Your Wayfinder ID session ended
      elsewhere, and Wayfinder ID told Rewards over the back channel (SAML single logout) at ${esc(utcTime(notice.ended.at))}.</p>`;
  } else if (notice?.signedOut) {
    message = '<p class="notice" role="status">You have signed out of Wayfinder Rewards and Wayfinder ID.</p>';
  }

  return layout(
    "Wayfinder Rewards",
    SIGN_IN_BUTTON,
    `    <section class="hero">
      <div>
        <p class="eyebrow">The Wayfinder loyalty programme</p>
        <h1>Every journey earns more.</h1>
        <p class="lead">Collect points on every Wayfinder flight and stay, climb from Silver to Platinum, and spend
          points on upgrades and lounges. One Wayfinder ID for Wayfinder and Rewards.</p>
        ${SIGN_IN_BUTTON}
        ${message}
      </div>
      <div class="hero-card" aria-hidden="true">
        <span class="card-brand">Wayfinder Rewards</span>
        <span class="card-tier">Gold</span>
        <span class="card-points">24,680 <small>points</small></span>
      </div>
    </section>
    <section class="tiers" aria-label="Membership tiers">
      <div class="tier tier--silver"><h2>Silver</h2><p>Priority check-in and 25% bonus points.</p></div>
      <div class="tier tier--gold"><h2>Gold</h2><p>Lounge access and an extra bag on every trip.</p></div>
      <div class="tier tier--platinum"><h2>Platinum</h2><p>Free upgrades when seats allow, and a personal concierge.</p></div>
    </section>`
  );
}

function detail(label: string, value: string | undefined, missing: string): string {
  return `<div><dt>${esc(label)}</dt><dd>${value ? esc(value) : `<span class="missing">${esc(missing)}</span>`}</dd></div>`;
}

export function memberPage(session: MemberSession): string {
  const member = memberFrom(session);
  const tierClass = (member.tier || "member").toLowerCase().replace(/[^a-z]/g, "");
  const attributeRows = Object.entries(session.attributes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, values]) => `<tr><th scope="row"><code>${esc(name)}</code></th><td>${esc(values.join(", "))}</td></tr>`)
    .join("\n          ");
  const firstName = member.name.split(/\s+/)[0];

  return layout(
    "Wayfinder Rewards: your membership",
    `<form method="post" action="/logout" class="signed-in">
      <span>Signed in as <strong>${esc(firstName)}</strong></span>
      <button class="button button--ghost" type="submit">Sign out</button>
    </form>`,
    `    <section class="member">
      <div class="member-card member-card--${esc(tierClass)}">
        <span class="card-brand">Wayfinder Rewards</span>
        <span class="card-name">${esc(member.name)}</span>
        <span class="card-tier">${esc(member.tier || "Tier not released")}</span>
        <span class="card-points">${esc(member.points || "—")} <small>points</small></span>
        <span class="card-id">${esc(session.nameID)}</span>
      </div>
      <div class="panel">
        <h2>Your profile</h2>
        <dl class="details">
          ${detail("Name", member.name, "Not released")}
          ${detail("Email", member.email, "Not released")}
          ${detail("Mobile", member.phone, "Not shared (optional)")}
          ${detail("Loyalty tier", member.tier, "Not released")}
          ${detail("Points", member.points, "Not released")}
        </dl>
        <p class="hint">Mobile is optional for Rewards. Share or revoke it in Wayfinder ID &rsaquo; My Account &rsaquo; Consents;
          the change shows at your next sign-in.</p>
      </div>
    </section>
    <section class="panel">
      <h2>Your SAML session</h2>
      <dl class="details details--wide">
        ${detail("NameID", session.nameID, "")}
        ${detail("NameID format", session.nameIDFormat, "Not sent")}
        ${detail("SessionIndex", session.sessionIndex, "Not sent")}
        ${detail("Identity provider", session.issuer, "Unknown")}
        ${detail("Signed in at", utcTime(session.createdAt), "")}
      </dl>
      <p class="hint">Signing out of Wayfinder or any other app on Wayfinder ID ends this session too: Wayfinder ID sends
        Rewards a back-channel LogoutRequest for this NameID and SessionIndex.</p>
    </section>
    <section class="panel">
      <h2>Attributes in the assertion</h2>
      ${
        attributeRows
          ? `<div class="table-wrap"><table>
        <thead><tr><th scope="col">Attribute</th><th scope="col">Value</th></tr></thead>
        <tbody>
          ${attributeRows}
        </tbody>
      </table></div>`
          : '<p class="missing">The assertion carried no attributes. Check the Rewards application\'s User Attributes in Wayfinder ID.</p>'
      }
    </section>`
  );
}

export function errorPage(title: string, message: string): string {
  return layout(
    "Wayfinder Rewards: sign-in problem",
    SIGN_IN_BUTTON,
    `    <section class="panel panel--error">
      <h1>${esc(title)}</h1>
      <p class="notice notice--error" role="alert">${esc(message)}</p>
      <p><a class="button button--gold" href="/login">Try again</a> <a class="button button--ghost" href="/">Home</a></p>
    </section>`
  );
}
