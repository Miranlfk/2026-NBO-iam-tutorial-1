# Wayfinder agent replay

A single-file script that **calls the Wayfinder sign-in as an AI agent would**:
it sends the Wayfinder SPA's OIDC authorization request to Asgardeo with an
agent User-Agent and agent headers, follows the redirects to the login page,
and prints what came back. Run it once as a browser and once as an agent to
show the login flow recognising agents and stepping up or denying them.

## What it shows in the demo (W14)

```text
$ ./agent_replay.py --preset browser
  1  GET  302  api.wso2isdemo.com/t/wso2demo/oauth2/authorize?response_type=code&client_id=...
               -> accounts.wso2isdemo.com/t/wso2demo/authenticationendpoint/login.do?...
  2  GET  200  accounts.wso2isdemo.com/t/wso2demo/authenticationendpoint/login.do?...
               text/html, 80.9 KB

Result: LOGIN PAGE served (no challenge detected)
  authenticators: BasicAuthenticator:LOCAL
  form: username + password

$ ./agent_replay.py --preset chatgpt-user -H 'X-Agent-Id: trip-planner'
...
Result: DENIED - error page served          (or CHALLENGE, or AUTHENTICATOR PAGE after --login)
```

The report names one of: `LOGIN PAGE`, `CHALLENGE` (a CAPTCHA widget is
rendered), `AUTHENTICATOR PAGE` (a further step such as TOTP or email OTP: a
step-up), `DENIED` (Asgardeo's retry/error page, or a redirect back with
`error=access_denied`), `BLOCKED` (HTTP 403), `THROTTLED` (HTTP 429),
`OAUTH ERROR PAGE` (wrong client id or redirect URI), or `SIGNED IN` (an
authorization code came back; it is never exchanged).

If the login flow's script only steps up **after** the first factor, use
`--login` with a test user: the script submits the username and password and
reports the next page (for example `AUTHENTICATOR PAGE - totp.do` for the agent
and `SIGNED IN` for the browser).

## Presets

| Preset | User-Agent | Extra headers |
|---|---|---|
| `browser` | desktop Chrome 130 | |
| `headless` | `HeadlessChrome/130` | |
| `gptbot` (default) | OpenAI `GPTBot/1.2` crawler | |
| `chatgpt-user` | `ChatGPT-User/1.0` (agent acting for a user) | `Signature-Agent: "https://chatgpt.com"` |
| `claudebot` | Anthropic `ClaudeBot/1.0` crawler | |
| `perplexitybot` | `PerplexityBot/1.0` crawler | |

`--list-presets` prints the full strings. `--user-agent '...'` overrides the
preset's User-Agent, and `-H 'Name: value'` adds headers (repeatable), e.g.
`-H 'X-Agent-Id: trip-planner'`. The `Signature-Agent` header is only the claim
an agent makes; no Web Bot Auth signature is computed.

## Safety

- One request sequence per run: the authorize request, at most 10 redirects,
  and with `--login` at most two form posts. No retries, loops or concurrency.
- Only HTTPS calls to the configured Asgardeo hosts (`REPLAY_ALLOWED_HOSTS`,
  default the `ASGARDEO_BASE_URL` host plus `accounts.<parent domain>`); a
  redirect anywhere else is reported, not followed.
- It stops at the Wayfinder redirect URI and never exchanges a code.
- Passwords are read from `REPLAY_PASSWORD` or a prompt, never from the command
  line, and never printed. Use a test user.

## Asgardeo set-up

Nothing new. The script uses the **Wayfinder SPA's client id**
(`WAYFINDER_CLIENT_ID`) and one of its registered redirect URLs
(`WAYFINDER_REDIRECT_URI`), with PKCE (S256), `response_type=code` and
`openid profile`, exactly like the SPA. The detection is the Wayfinder
application's **Login Flow** conditional authentication script, which reads
`context.request.headers`. A sketch of such a script (step 2 = an OTP
authenticator configured in the flow):

```js
var agentMarkers = ['gptbot', 'chatgpt-user', 'claudebot', 'perplexitybot', 'headlesschrome'];

var onLoginRequest = function (context) {
    var headers = context.request.headers;
    var userAgent = String(headers['user-agent'] || '').toLowerCase();
    var isAgent = Boolean(headers['signature-agent'] || headers['x-agent-id']) ||
        agentMarkers.some(function (marker) { return userAgent.indexOf(marker) >= 0; });

    executeStep(1, {
        onSuccess: function (context) {
            if (isAgent) {
                Log.info('Agent client on Wayfinder sign-in: ' + userAgent);
                executeStep(2);
            }
        }
    });
};
```

## Configuration

See [`.env.example`](.env.example); the script reads `.env` next to itself (or
`--env-file`), and real environment variables win.

| Variable | Meaning | Example |
|---|---|---|
| `ASGARDEO_BASE_URL` | organization base URL | `https://api.wso2isdemo.com/t/wso2demo` |
| `WAYFINDER_CLIENT_ID` | the Wayfinder SPA's client id | `aBcD...` |
| `WAYFINDER_REDIRECT_URI` | a redirect URL registered on the SPA | `https://wayfinder.<APPS_DOMAIN>` |
| `REPLAY_SCOPES` | scopes in the authorization request | `openid profile` |
| `REPLAY_ALLOWED_HOSTS` | hosts the script may call | `api.wso2isdemo.com,accounts.wso2isdemo.com` |
| `REPLAY_USERNAME` | test user for `--login` | `replay.tester@example.com` |
| `REPLAY_PASSWORD` | its password (empty: prompt) | |

## Run

Python 3.9 or newer, standard library only.

```bash
cp .env.example .env        # set WAYFINDER_CLIENT_ID and WAYFINDER_REDIRECT_URI
./agent_replay.py --preset browser
./agent_replay.py --preset gptbot
./agent_replay.py --preset chatgpt-user -H 'X-Agent-Id: trip-planner'
./agent_replay.py --preset headless --login      # submits REPLAY_USERNAME, prompts for the password
./agent_replay.py --dry-run                      # print the request only
./agent_replay.py --save-html last-page.html     # keep the last page for a closer look
```

Asgardeo local answers only allowlisted IPs, so run it from an allowed network.
