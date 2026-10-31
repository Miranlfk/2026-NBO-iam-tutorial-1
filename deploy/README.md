# Deploying Wayfinder with Docker Compose

`compose.yaml` runs the six Wayfinder components on one Docker host behind a
reverse proxy that terminates TLS (Caddy in our setup). Nothing in the images is
tied to a domain or an identity provider: the public domain (`APPS_DOMAIN`) and the
Asgardeo organization (`ASGARDEO_BASE_URL`) are read when the containers start.

| Service | Build context (from repo root) | Dockerfile | Container port | Host port (127.0.0.1) | Public hostname | Health |
| --- | --- | --- | --- | --- | --- | --- |
| `frontend` | `asgardeo-b2c-sample-app/frontend` | `Dockerfile` | 8080 | `FRONTEND_HOST_PORT` (8080) | `wayfinder.<APPS_DOMAIN>` | `GET /healthz` |
| `api` | `asgardeo-b2c-sample-app` | `api/Dockerfile` | 8787 | `API_HOST_PORT` (8787) | `api.<APPS_DOMAIN>` | `GET /health` |
| `mcp` | `asgardeo-b2c-sample-app` | `mcp/Dockerfile` | 8000 | `MCP_HOST_PORT` (8000) | `mcp.<APPS_DOMAIN>` | `GET /health` |
| `booking-agent` | `asgardeo-b2c-sample-app/booking-agent` | `Dockerfile` | 5001 | `AGENTS_HOST_PORT` (5001) | `agents.<APPS_DOMAIN>` | `GET /health` |
| `ambient-agent` | `asgardeo-b2c-sample-app/ambient-agent` | `Dockerfile` | 8790 | none (internal) | none | `GET /health` |
| `vc-verifier` | `vc-verifier` | `Dockerfile` | 3001 | `VERIFIER_HOST_PORT` (3001) | `verifier.<APPS_DOMAIN>` | `GET /health` |
| `self-service-mcp` | `self-service-mcp` | `Dockerfile` | 8000 | none (internal) | none | port open |

`api` and `mcp` share the `asgardeo-b2c-sample-app` build context because the MCP
server loads the API's `api/src/db.ts` in process. They also share the named
volume `wayfinder-data`, which holds the SQLite file at `/data/wayfinder.db`
(WAL mode). Both images run as uid 1000.

```text
browser ─▶ frontend (SPA)            booking-agent ─▶ mcp ─┐
browser ─▶ api ─────────────────────────────────────────── ├─▶ /data/wayfinder.db
api ─▶ ambient-agent (new-flight webhook) ─▶ mcp ─────────┘
all of them ─▶ Asgardeo (ASGARDEO_BASE_URL);  agents ─▶ LLM gateway
```

## Configure

```bash
cd deploy
cp .env.example .env                       # APPS_DOMAIN, ASGARDEO_BASE_URL, image names, ports
for f in env/*.env.example; do cp "$f" "${f%.example}"; done
```

Fill in `env/*.env`. Each `*.env.example` documents every variable of its
service; `env/llm.env` is shared by both agents. The real files are git-ignored.

- Values under `environment:` in `compose.yaml` are derived from `APPS_DOMAIN`
  and `ASGARDEO_BASE_URL` and win over the env files. Override one by setting
  the variable of the same name in `deploy/.env` (listed at the end of
  `.env.example`).
- Env-file syntax: `KEY=value`, no spaces around `=`. Compose expands `$` in env
  files, so wrap secrets that contain `$` in single quotes. JSON values
  (`TRUSTED_ISSUER_JWKS`, `REQUEST_DCQL_CLAIMS`) go unquoted or single-quoted.

Two values for the verifier are generated per deployment:

```bash
# Request-object signing key (EC P-256 private JWK) -> REQUEST_SIGNING_PRIVATE_JWK
docker run --rm node:22-alpine node -e "const {generateKeyPairSync}=require('crypto');console.log(JSON.stringify(generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({format:'jwk'})))"

# Trusted issuer keys -> TRUSTED_ISSUER_JWKS (keyed by the credential issuer)
. ./.env; printf "TRUSTED_ISSUER_JWKS='{\"%s/oid4vci\":%s}'\n" "$ASGARDEO_BASE_URL" "$(curl -s "$ASGARDEO_BASE_URL/oauth2/jwks")"
```

The OID4VCI issuer metadata (`<ASGARDEO_BASE_URL>/oid4vci/.well-known/openid-credential-issuer`)
has no `jwks_uri`, so the verifier cannot discover the keys itself
(`ALLOW_REMOTE_JWKS`); refresh `TRUSTED_ISSUER_JWKS` if the organization's
signing key rotates.

## Build and run

```bash
docker compose build                 # or one at a time: docker compose build api
docker compose up -d
docker compose ps                    # all services should become "healthy"
docker compose logs -f api mcp
```

Images are tagged `${WAYFINDER_IMAGE_PREFIX:-wayfinder}/<service>:${WAYFINDER_IMAGE_TAG:-latest}`,
so they can be pushed to a registry and pulled on the VM (`docker compose pull`)
instead of building there.

Start order (from `depends_on`): `api` first; `mcp` once `api` is healthy;
`booking-agent` and `ambient-agent` once `mcp` is healthy. `frontend` and
`vc-verifier` start immediately.

- **Database.** On every start the `api` container runs
  `node scripts/seed.js --if-missing`: it creates and seeds the database only
  when the catalogue tables are absent (inside an `IMMEDIATE` transaction, so
  two starters cannot both seed), and leaves an existing database, including
  bookings, alone. `mcp` never seeds; it starts after `api` is healthy. To start
  over: `docker compose down && docker volume rm wayfinder_wayfinder-data`
  (the name is `<project>_wayfinder-data`).
- **Agents and the identity provider.** `booking-agent` and `ambient-agent`
  obtain their agent tokens at startup and exit if Asgardeo (or, for the ambient
  agent, the MCP server) is unreachable; `restart: unless-stopped` retries.
- **Switching domains.** Change `APPS_DOMAIN` in `.env` and run
  `docker compose up -d` (no rebuild), then update the redirect URLs and
  allowed origins in Asgardeo (below).

## Reverse proxy (Caddy)

| Hostname | Upstream (proxy on the host) | Upstream (proxy container on the `wayfinder` network) |
| --- | --- | --- |
| `wayfinder.<APPS_DOMAIN>` | `127.0.0.1:8080` | `frontend:8080` |
| `api.<APPS_DOMAIN>` | `127.0.0.1:8787` | `api:8787` |
| `mcp.<APPS_DOMAIN>` | `127.0.0.1:8000` | `mcp:8000` |
| `agents.<APPS_DOMAIN>` | `127.0.0.1:5001` | `booking-agent:5001` |
| `verifier.<APPS_DOMAIN>` | `127.0.0.1:3001` | `vc-verifier:3001` |

The ambient agent is not proxied; the API reaches it at `http://ambient-agent:8790`.
The Docker network is named `wayfinder` (`WAYFINDER_NETWORK`), so a Caddy container
from another Compose project can join it as an external network.

What the proxy has to carry:

- **No WebSockets.** The browser talks to the API and the booking agent over plain
  HTTPS (`fetch`).
- **SSE on `mcp.`:** `POST /mcp` (MCP Streamable HTTP, stateless) answers with
  `Content-Type: text/event-stream`. Caddy flushes event streams immediately;
  do not enable response buffering. `GET /mcp` returns 405 (no standalone stream).
- **Long requests on `agents.`:** `POST /api/chat` waits for the LLM and the MCP
  tool calls (tens of seconds). Caddy has no response timeout by default; keep it
  that way or allow at least 120 s.
- **Body sizes:** the API accepts JSON up to 1 MB; the wallet's OID4VP
  `direct_post` to `verifier./openid4vp/authorization-response` carries an SD-JWT
  presentation (a few KB, form-encoded). Caddy sets no limit by default; if you
  add `request_body max_size`, keep it at 1 MB or more.
- **Browser redirects:** the OBO consent popup returns to
  `https://agents.<APPS_DOMAIN>/api/obo/callback`.
- **Unauthenticated writes on `api.`:** `POST /api/flights` (adds a flight and
  triggers the ambient agent's deal-alert flow) and `DELETE /api/flights/{id}`
  need no token, even with `API_REQUIRE_AUTH=true`. They are the presenter's
  trigger; restrict them by source IP if the API is public.

```caddyfile
wayfinder.{$APPS_DOMAIN} {
	reverse_proxy 127.0.0.1:8080
}

api.{$APPS_DOMAIN} {
	@flight_writes {
		path /api/flights /api/flights/*
		method POST DELETE
		not remote_ip 203.0.113.0/24   # presenter / admin addresses
	}
	respond @flight_writes 403
	reverse_proxy 127.0.0.1:8787
}

mcp.{$APPS_DOMAIN} {
	reverse_proxy 127.0.0.1:8000 {
		flush_interval -1
	}
}

agents.{$APPS_DOMAIN} {
	reverse_proxy 127.0.0.1:5001
}

verifier.{$APPS_DOMAIN} {
	reverse_proxy 127.0.0.1:3001
}
```

## Identity provider resources

What the code expects in the Asgardeo organization. URLs are relative to the
public hostnames above. Identifiers in angle brackets are free to choose but
must match the env files.

**Wayfinder SPA** (`frontend`; `VITE_ASGARDEO_CLIENT_ID`, `VITE_ASGARDEO_APPLICATION_ID`)

- Single-page application (public client, PKCE), grants `authorization_code` and
  `refresh_token`.
- Authorized redirect URL and post-logout redirect: `https://wayfinder.<APPS_DOMAIN>`
  (the SDK uses the page origin for both). Access URL: the same.
- Allowed origin: `https://wayfinder.<APPS_DOMAIN>` (token, SCIM `/scim2/Me` and
  branding calls from the browser).
- Scopes requested: `openid profile internal_login` (added by the SDK) plus
  `VITE_ASGARDEO_SCOPES`: `bookings:read bookings:write deal-alert-consents:write`
  and, with `API_REQUIRE_AUTH=true`, `profile:read profile:write`. The sign-in
  request also carries `anonymous_profile_tracker` (CDS profile merge).
- User attributes: username, email, first name (`given_name`), last name
  (`family_name`). Access token: JWT, with `username` and `email` included as
  access-token attributes. With `API_REQUIRE_AUTH=true` the API keys bookings
  and deal-alert consents on the verified token's `username` claim (falling back
  to `preferred_username`, `email`, then `sub`) and ignores the `X-Wayfinder-*`
  headers. The MCP server keys OBO and CIBA bookings the same way, so every
  client that reads a user's bookings (SPA, agents, the in-flight screen's
  device-flow token) must carry the same `username` claim.
- Authorized API: the WayFinder API resource with the scopes above.
- Users can edit their own name and email (`PATCH /scim2/Me` with their token).
- Self sign-up enabled: the Sign up button opens
  `https://accounts.<idp-domain>/t/<org>/accounts/register` (or `VITE_ASGARDEO_SIGN_UP_URL`).

**WayFinder API resource** (`api` `ASGARDEO_AUDIENCE`), requires authorization.
Scopes checked by the API: `bookings:read` (GET bookings), `bookings:write`
(POST/PATCH bookings; not `bookings:create`), `deal-alert-consents:read`,
`deal-alert-consents:write`, `profile:read` (GET `/api/me`, `/api/me/profile`),
`profile:write` (PATCH `/api/me/profile`). Users' role must grant them.

**MCP server resource** (`mcp` `ASGARDEO_AUDIENCE` = agents' `AGENT_RESOURCE` =
`OBO_RESOURCE`). Scopes: `mcp:search_flights`, `mcp:get_locations`,
`mcp:create_bookings`, `mcp:cancel_booking`, `mcp:deal-alert-consents:read`,
`mcp:deal-alert-consents:write`. Users' role grants all of them; no agent role
grants `mcp:cancel_booking`, so a gateway ACL (or the token) can allow booking
without cancelling. `search_hotels`, `get_trips` and
`get_flight_bookings` need a valid token but no scope. A role is never accepted in
place of a scope at this boundary. If the REST and MCP scopes share one resource,
use its identifier for all three settings.

**MCP revocation check** (`mcp` `MCP_INTROSPECTION_CLIENT_ID` / `_SECRET`): an
application in the organization with client credentials (any confidential app
works). The MCP server introspects every verified token at
`<ASGARDEO_BASE_URL>/oauth2/introspect`, so revoking an agent's access in My
Account (consent, authorized apps) stops it within `MCP_INTROSPECTION_CACHE_SECONDS`.

**Step-up re-authentication** (`frontend` `VITE_STEP_UP_ACR_FACE`,
`VITE_STEP_UP_ACR_HIGH_VALUE`, `VITE_HIGH_VALUE_FARE_LIMIT`)

- "Verify with face" on the profile page, and paying a fare above
  `VITE_HIGH_VALUE_FARE_LIMIT` (default 1000; 0 turns it off), sign the user in
  again with `prompt=login` and `acr_values=face` or `acr_values=high-value`, then
  return to the page.
- The SPA's login flow (conditional authentication script) acts on
  `context.requestedAcr`: `face` adds the face liveness step (iProov), `high-value`
  calls the external policy service and steps up to TOTP. It must set
  `context.selectedAcr` to the requested value: the SPA reads `acr` from the ID
  token to know the step-up happened.

**Profile fields** (`api` `MARKETING_PREFERENCE_NAME`, `frontend` `VITE_MY_ACCOUNT_URL`)

- `GET /api/me/profile` adds `loyaltyId` (custom attribute `loyaltyId`, in any SCIM
  schema extension), `dateOfBirthProvided` (whether `dateOfBirth` is set; the date
  is never returned) and `marketing`: the user's subscription to the communication
  preference named `MARKETING_PREFERENCE_NAME` (default `Marketing`; Preference
  Management), from `GET /api/users/v1/me/consents` with the user's token.
- The profile page shows `loyalty_tier` and `crm_tier` from the access token (added
  by a pre-issue access token action), and links to My Account
  (`VITE_MY_ACCOUNT_URL`, default `https://myaccount.<idp-domain>/t/<org>/`).
- Sign-up: add the Marketing preference to the self-registration flow; the Rewards
  application requests the mobile number as optional.

**Account assistant** (`booking-agent` `SELF_SERVICE_MCP_URL`; `self-service-mcp`)

- `POST /api/account/chat` (the profile page's assistant) runs the agent with the
  Asgardeo self-service MCP server's tools, called with the user's own SPA token
  (needs `internal_login`, which the SDK requests). The server is built from
  `asgardeo/asgardeo-mcp-server` (`cmd/self-service-mcp`) at the commit in
  `self-service-mcp/Dockerfile`; `CLIENT_ID` = the SPA's client ID.

**Extra sign-in options** (`frontend` `VITE_WALLET_SIGN_IN_CONNECTION`,
`VITE_SIWE_SIGN_IN_CONNECTION`): the names of the connections for wallet sign-in
(OpenID4VP, presentation definition for the member credential) and Sign-In with
Ethereum. Each one set adds an option under Sign in that starts at that connection
(`fidp=<name>`); both must also be in the SPA's login flow.

**Booking agent** ("Wayfinder Assistant", interactive agent; `AGENT_ID`,
`AGENT_SECRET`) and its application (`ASGARDEO_CLIENT_ID`, `ASGARDEO_CLIENT_SECRET`)

- "Allow users to log in to this agent" on; confidential client; grant
  `authorization_code`; authorized redirect URL
  `https://agents.<APPS_DOMAIN>/api/obo/callback` (used for the agent's own token
  and for OBO).
- App-native authentication enabled, with Username & Password in the login flow:
  the agent's own token comes from `POST /oauth2/authorize` with
  `response_mode=direct`, then `/oauth2/authn` with the agent ID and secret.
- Agent token: `AGENT_SCOPES` = `openid profile mcp:search_flights mcp:get_locations`,
  `resource=<MCP resource>`; the agent's role grants those two scopes only.
- OBO: the user is sent to `/oauth2/authorize` with `requested_actor=<agent id>`,
  `OBO_SCOPES` = `openid profile mcp:create_bookings` and `resource=<MCP resource>`;
  the code is exchanged with `actor_token=<agent token>`, so the token carries
  `act.sub` = agent ID. Users' role grants `mcp:create_bookings`; the agent's does not.
- Access token: JWT with `username` (and `email`) as access-token attributes: the MCP
  server takes the booking owner from `username` in the OBO token, and it has to
  equal the SPA user's username for the booking to show in "My bookings".
- The user's SPA token is checked on `/api/chat`: `aud` contains the SPA client ID
  (`TOKEN_AUDIENCE`), `iss` = `<ASGARDEO_BASE_URL>/oauth2/token`.

**Ambient agent** ("Wayfinder Ambient Assistant", background agent; `AGENT_ID`,
`AGENT_SECRET`) and its application (`CLIENT_ID`, `CLIENT_SECRET`)

- Confidential client; grants `authorization_code` (agent token, app-native
  authentication as above) and CIBA (`urn:openid:params:grant-type:ciba`);
  authorized redirect URL = `REDIRECT_URI` (default `http://ambient-agent:8790/callback`,
  never visited).
- Agent token: `AGENT_SCOPES` = `openid profile mcp:deal-alert-consents:read`, no
  `resource` parameter: the MCP resource must end up in `aud` from the scope alone.
  The agent's role grants `mcp:deal-alert-consents:read`.
- CIBA: `POST /oauth2/ciba` with client_secret_basic, `login_hint` = the booking's
  username, `binding_message` (up to about 250 characters), `notification_channel`
  = `CIBA_NOTIFICATION_CHANNEL` (default `email`), `actor_token` = agent token,
  `scope` = `CIBA_SCOPE` (`openid profile profile:read mcp:create_bookings
  mcp:deal-alert-consents:write`); then polls `/oauth2/token`. Allowed notification
  channels: email (and SMS if used). Expiry: Asgardeo's `expires_in` bounds the
  polling (`CIBA_POLL_TIMEOUT_MS` overrides).
- The CIBA access token must carry a `username` claim (the agent refuses it
  otherwise). Users' role grants `mcp:create_bookings` and
  `mcp:deal-alert-consents:write` (and `profile:read` if kept in `CIBA_SCOPE`).

**Customer Data Service** (`api` CDS proxy)

- CDS enabled for the organization. An M2M application (client credentials,
  `CDS_ASGARDEO_CLIENT_ID` / `_SECRET`) authorized for `CC_SCOPES`:
  `internal_cds_profile_create internal_cds_profile_update internal_cds_profile_view
  internal_cds_profile_schema_view`; registered as a CDS system application
  (`PATCH <ASGARDEO_BASE_URL>/cds/api/v1/config` with
  `"system_applications": ["CONSOLE", "<m2m client id>"]`).
- Profile attribute (application data of the Wayfinder SPA): `fav_flights`, text,
  multi-valued, read/write, merge strategy combine.
- Calls made: `POST /cds/api/v1/profiles` (reads the `cds_profile` cookie from the
  response), `GET /cds/api/v1/profiles/{id}?application_identifier=*&includeApplicationData=true`,
  `PATCH /cds/api/v1/profiles/{id}`.

**Verifiable credential** (`frontend` wallet QR, `vc-verifier`)

- VC attribute `member_since` mapped to `http://wso2.org/claims/created`.
- Credential template `Wayfinder_member_Id` ("Wayfinder Member ID"), format
  `dc+sd-jwt`, `vct` `Wayfinder_member_Id`, claims including `userid` and
  `member_since` (the verifier requires both; the tutorial also adds first name,
  last name, email); validity 1825 days. Its offer URL goes in
  `VITE_WALLET_CREDENTIAL_OFFER`.
- A wallet application (the tutorial registers Lissi: public client
  `9c481dc3-2ad0-4fe0-881d-c32ad02fe0fc`, redirect `https://oob.lissi.io/vci-cb`,
  PKCE, template `digital-wallet-application`) authorized for the template.
- The verifier trusts issuer `<ASGARDEO_BASE_URL>/oid4vci` with the keys from
  `/oauth2/jwks` (`TRUSTED_ISSUER_JWKS`).

**LLM gateway client** (`env/llm.env`): a client-credentials application whose
token the API Manager AI gateway accepts (`LLM_CLIENT_ID`, `LLM_CLIENT_SECRET`,
optional `LLM_TOKEN_SCOPE`).
