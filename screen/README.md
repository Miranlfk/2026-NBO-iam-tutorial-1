# Wayfinder in-flight screen

A seat-back (or TV) page that signs a traveller in with the **OAuth 2.0 device
authorization grant** (RFC 8628) and shows their **next Wayfinder trip**.

## What it shows in the demo (W10)

1. Open `https://screen.<APPS_DOMAIN>` and click **Sign in**: the screen shows a
   user code, the verification URI and a QR code of `verification_uri_complete`.
2. On the phone, scan the QR, sign in as alex (passkey) and confirm the code.
3. The screen notices the approval on its next poll and shows "Welcome back,
   Alex" with alex's upcoming trip from the Wayfinder API, then **Sign out**.

The screen never sees a password and has no keyboard: the phone does the
authentication. Denying on the phone, or letting the code expire, brings the
screen back to the start with a message.

## How it works

A small Express server does every OAuth call, so the client id and URLs come
from the environment at runtime and there is no CORS:

| Step | Server call |
|---|---|
| Sign in | `POST <ASGARDEO_BASE_URL>/oauth2/device_authorize` (`client_id`, `scope`) |
| Polling | `POST /oauth2/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`, at the returned `interval`; `authorization_pending` keeps waiting, `slow_down` adds 5 s, `access_denied` / `expired_token` / code expiry end the attempt |
| Traveller | name and username from the ID token (or `/oauth2/userinfo` if there is none) |
| Next trip | `GET <WAYFINDER_API_URL>/api/bookings/flights` with `Authorization: Bearer <access token>` (needs `bookings:read`) plus the `X-Wayfinder-Username/User-Id/Email` headers the Wayfinder SPA sends, so the API finds the same bookings |
| Sign out | `POST /oauth2/revoke` for the access and refresh tokens (best effort), then the session is dropped |

Tokens stay in a server-side, in-memory session; the browser only holds an
opaque `screen_sid` cookie (HttpOnly, SameSite=Lax, Secure behind TLS). The page
polls `POST /poll`, and the server enforces the interval itself, so reloads or
extra tabs never poll Asgardeo faster. The next trip is the earliest
non-cancelled booking whose start date (`dates`, e.g. `Nov 05 - Nov 14`) is
today or later; if there is none, the latest booking is shown.

| Path | Purpose |
|---|---|
| `GET /` | welcome, pairing (code + QR) or traveller page, depending on the session |
| `POST /signin`, `/poll`, `/cancel`, `/signout` | device flow steps |
| `GET /health` | `{"status":"ok"}` for Docker and Caddy |

## Asgardeo set-up (Asgardeo local, organization `wso2demo`)

1. **Application**: Console > Applications > New Application > **Standard-Based
   Application**, protocol **OAuth 2.0 / OpenID Connect**, name
   `Wayfinder In-flight Screen`.
2. **Protocol** tab:
   - Allowed grant types: **Device Code** (and **Refresh Token**). Code is not
     needed.
   - **Public client**: on ("Allow authentication without the client secret").
     The screen sends no secret. (For a confidential client, set
     `ASGARDEO_CLIENT_SECRET`.)
   - Authorized redirect URLs: leave empty (only the Code and Implicit grants
     need one). After approval, the phone lands on Asgardeo's device success page.
   - Access token type: **JWT** (the Wayfinder API verifies tokens against JWKS).
3. **User Attributes** tab: request **Email**, **First Name**, **Last Name** and
   **Username** (the API stores bookings under the username the SPA sends).
4. **API Authorization** tab: authorize the **WayFinder API** resource
   (identifier `https://api.wayfinderapp.com` in the tutorial) with the scope
   **`bookings:read`**.
5. Note the client id for `ASGARDEO_CLIENT_ID`.

Scopes requested: `openid profile email bookings:read`. The Wayfinder API must
accept the token's audience: its `ASGARDEO_AUDIENCE` should be the WayFinder API
identifier (which Asgardeo adds to `aud` when it grants `bookings:read`). If
the token comes back without it, set `ASGARDEO_RESOURCE` to the identifier, or
add the screen's client id to the API's `ASGARDEO_AUDIENCE` list.

## Configuration

See [`.env.example`](.env.example).

| Variable | Meaning | Example |
|---|---|---|
| `PORT` | listen port | `8791` |
| `ASGARDEO_BASE_URL` | organization base URL | `https://api.wso2isdemo.com/t/wso2demo` |
| `ASGARDEO_CLIENT_ID` | the screen application's client id | `aBcD...` |
| `ASGARDEO_CLIENT_SECRET` | empty for a public client | (empty) |
| `ASGARDEO_SCOPES` | requested scopes | `openid profile email bookings:read` |
| `ASGARDEO_RESOURCE` | optional resource indicator | `https://api.wayfinderapp.com` |
| `WAYFINDER_API_URL` | Wayfinder REST API | `https://api.<APPS_DOMAIN>` |
| `APPS_DOMAIN` | used for `https://api.<APPS_DOMAIN>` when `WAYFINDER_API_URL` is empty | `203-0-113-10.sslip.io` |

## Run

```bash
npm ci
npm run build
cp .env.example .env   # fill in the client id and the API URL
npm run dev            # http://localhost:8791
```

Container:

```bash
docker build -t wayfinder-screen .
docker run --rm -p 8791:8791 --env-file .env wayfinder-screen
```

Caddy (TLS in front of the container; the app trusts one proxy hop):

```caddyfile
screen.{$APPS_DOMAIN} {
	reverse_proxy screen:8791
}
```
