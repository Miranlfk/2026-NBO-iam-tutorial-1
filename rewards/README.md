# Wayfinder Rewards

The loyalty site of a second brand, **Wayfinder Rewards**. It signs members in
with **SAML 2.0** (Wayfinder ID, i.e. Asgardeo, is the IdP), shows the member
attributes from the assertion, and supports **back-channel single logout**.
It has its own look (plum and gold, Plus Jakarta Sans) so it reads as a
different brand from Wayfinder.

## What it shows in the demo (W11, W8)

- **One identity, two brands, two protocols.** Sign in to Wayfinder (OIDC), then
  open `https://rewards.<APPS_DOMAIN>`: **Sign in with Wayfinder ID** goes
  straight through by SSO and Rewards shows alex's name, email, loyalty tier and
  points from the SAML assertion.
- **Optional phone (W8).** Rewards asks for the mobile number as an optional
  attribute. If alex shared it, it shows; if not, or after revoking it in My
  Account > Consents and signing in again, the page says "Not shared
  (optional)".
- **Back-channel logout.** Sign out of Wayfinder (or any app on Wayfinder ID).
  Asgardeo posts a SAML `LogoutRequest` to Rewards server to server; Rewards
  ends the matching session. Reload Rewards: it is signed out and says it was
  ended by single logout. The container log shows
  `back-channel logout from ... ended 1 session(s)`.
- The page also lists the SAML session (NameID, format, SessionIndex, IdP) and
  every attribute in the assertion.

## How it works

Express plus [`@node-saml/node-saml`](https://github.com/node-saml/node-saml),
the SAML engine behind `@node-saml/passport-saml`. Passport is left out because
back-channel logout has no browser session for it to act on.

| Path | Purpose |
|---|---|
| `GET /` | member page when signed in, otherwise the landing page |
| `GET /login` | SP-initiated sign-in: AuthnRequest over HTTP-Redirect (signed if a key is set) |
| `POST /saml/acs` | assertion consumer service (HTTP-POST). Requires a signed Response, checks audience, timestamps, InResponseTo when present (IdP-initiated SSO also works) and assertion replay |
| `POST /saml/slo` | `SAMLRequest`: a LogoutRequest from the IdP (back channel). `SAMLResponse`: the IdP's answer to our logout |
| `GET /saml/slo` | HTTP-Redirect binding: LogoutResponse, or a front-channel LogoutRequest |
| `POST /logout` | ends the local session, then sends a LogoutRequest to the IdP to end the Wayfinder ID session |
| `GET /saml/metadata` | SP metadata (entity ID, ACS, SLO, signing cert if set, requested attributes with phone optional) |
| `GET /health` | `{"status":"ok","sessions":N}` |

**Sessions.** Server-side and in memory, indexed by **NameID + SessionIndex**
(from the assertion's AuthnStatement); the browser only holds an opaque
`rewards_sid` cookie (HttpOnly, SameSite=Lax, Secure behind TLS). A
back-channel LogoutRequest arrives without the member's browser, so it is
matched by NameID + SessionIndex, never by cookie. A request without a
SessionIndex ends all sessions of that NameID. Rewards answers `200` even when
no session matched, so Asgardeo does not retry.

**Logout signatures.** Signed LogoutRequests are verified against the IdP
certificate. Unsigned ones are refused unless `SAML_SLO_REQUIRE_SIGNATURE=false`
(then the issuer, if `SAML_IDP_ENTITY_ID` is set, and `NotOnOrAfter` are still
checked).

## Asgardeo set-up (Asgardeo local, organization `wso2demo`)

If Rewards lives in the **Rewards brand organization**, create it there and use
that organization's SAML endpoints, entity ID and certificate (the application's
**Info** tab) in the `SAML_IDP_*` variables.

1. **Application**: Console > Applications > New Application > **Standard-Based
   Application**, protocol **SAML**, name `Wayfinder Rewards`, configure
   manually (or import `https://rewards.<APPS_DOMAIN>/saml/metadata`):
   - Issuer: `wayfinder-rewards` (= `SAML_SP_ENTITY_ID`)
   - Assertion consumer service URL (default): `https://rewards.<APPS_DOMAIN>/saml/acs`
2. **Protocol** tab:
   - Single sign-on profile: bindings **HTTP Redirect** and **HTTP POST**. IdP
     initiated SSO: optional (on, if Rewards is launched from My Account).
   - Assertion: NameID format `urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress`;
     audience `wayfinder-rewards`; recipient = the ACS URL (both defaults).
   - Response signing: **Sign SAML responses** on (RSA-SHA256 / SHA256).
   - Request validation: off. Turn it on only if you set `SAML_SP_PRIVATE_KEY`
     and upload `SAML_SP_CERT` under the application's certificate.
   - Assertion encryption: off.
   - Attribute profile: **enabled**, and **Always include attribute profile in
     response** on (Rewards does not send an AttributeConsumingServiceIndex).
   - Single logout profile: **enabled**; logout method **Back Channel**; single
     logout response URL and single logout request URL both
     `https://rewards.<APPS_DOMAIN>/saml/slo`.
3. **User Attributes** tab (attribute names in the assertion are the local
   claim URIs):

   | Attribute | Claim URI | Requested as |
   |---|---|---|
   | First Name | `http://wso2.org/claims/givenname` | mandatory |
   | Last Name | `http://wso2.org/claims/lastname` | mandatory |
   | Email | `http://wso2.org/claims/emailaddress` | mandatory |
   | Loyalty Tier (custom) | `http://wso2.org/claims/loyaltyTier` | mandatory |
   | Loyalty Points (custom) | `http://wso2.org/claims/loyaltyPoints` | mandatory |
   | Mobile | `http://wso2.org/claims/mobile` | **requested, not mandatory** (W8) |

   Subject attribute: Email (the NameID). If the console lets you rename the
   SAML attribute names, either keep the claim URIs or set the `SAML_ATTR_*`
   variables to the new names.
4. **Custom attributes**: User Attributes & Stores > Attributes > New:
   `loyaltyTier` ("Loyalty Tier") and `loyaltyPoints` ("Loyalty Points"),
   giving `http://wso2.org/claims/loyaltyTier` and
   `http://wso2.org/claims/loyaltyPoints`. Set them on alex.
5. **Network**: Asgardeo's back-channel call goes from the core VM to
   `https://rewards.<APPS_DOMAIN>/saml/slo`, so that path must be reachable
   from there (no IP allowlist in front of it).

## Configuration

See [`.env.example`](.env.example) for every variable with comments.

| Variable | Meaning | Example |
|---|---|---|
| `PORT` | listen port | `8792` |
| `PUBLIC_URL` / `APPS_DOMAIN` | public base URL, or the apps domain for `https://rewards.<APPS_DOMAIN>` | `203-0-113-10.sslip.io` |
| `SAML_SP_ENTITY_ID` | SP entity ID / issuer | `wayfinder-rewards` |
| `SAML_ACS_URL` | ACS URL (default `<PUBLIC_URL>/saml/acs`) | |
| `SAML_SLO_URL` | SLO URL (default `<PUBLIC_URL>/saml/slo`) | |
| `SAML_NAMEID_FORMAT` | requested NameID format (empty: none) | `urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress` |
| `SAML_SP_PRIVATE_KEY`, `SAML_SP_CERT` | optional PEM pair to sign AuthnRequests/LogoutRequests | |
| `SAML_IDP_SSO_URL` | IdP SSO URL | `https://api.wso2isdemo.com/t/wso2demo/samlsso` |
| `SAML_IDP_SLO_URL` | IdP SLO URL (default: SSO URL) | same |
| `SAML_IDP_ENTITY_ID` | expected IdP issuer (optional) | `api.wso2isdemo.com/t/wso2demo` |
| `SAML_IDP_CERT` | IdP signing certificate, PEM or base64 | |
| `SAML_IDP_METADATA_URL` | or read the certificate from IdP metadata | `https://api.wso2isdemo.com/t/wso2demo/identity/metadata/saml2` |
| `SAML_WANT_RESPONSE_SIGNED` | require a signed Response | `true` |
| `SAML_WANT_ASSERTIONS_SIGNED` | also require a signed Assertion | `false` |
| `SAML_SLO_REQUIRE_SIGNATURE` | require signed LogoutRequests | `true` |
| `SAML_ATTR_FIRST_NAME`, `_LAST_NAME`, `_EMAIL`, `_PHONE`, `_LOYALTY_TIER`, `_LOYALTY_POINTS` | attribute names in the assertion | claim URIs above |

## Run

```bash
npm ci
npm run build
cp .env.example .env
npm run dev            # http://localhost:8792 (set PUBLIC_URL=http://localhost:8792 for local SAML)
```

Container:

```bash
docker build -t wayfinder-rewards .
docker run --rm -p 8792:8792 --env-file .env wayfinder-rewards
```

Caddy (TLS in front of the container; the app trusts one proxy hop):

```caddyfile
rewards.{$APPS_DOMAIN} {
	reverse_proxy rewards:8792
}
```
