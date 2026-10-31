#!/usr/bin/env python3
"""Wayfinder agent replay.

Sends the Wayfinder SPA's OIDC authorization request to Asgardeo with an AI-agent
(or headless, or ordinary browser) User-Agent and extra agent headers, follows
the redirects to the login page, and reports what came back: each hop's status
and redirect, and whether a login page, a challenge or a denial was served. With
--login it also submits a test user's username and password, to show a step-up
that the login flow's script applies after the first step.

Safe by design: one request sequence per run, no retries, no concurrency, and it
only talks to the configured Asgardeo hosts. It never exchanges an authorization
code for tokens. Python 3.9+ standard library only.
"""

from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import http.cookiejar
import os
import re
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path
from typing import Dict, List, Optional, Tuple

MAX_REDIRECTS = 10
TIMEOUT_SECONDS = 15

# name: (description, User-Agent, extra headers)
PRESETS: Dict[str, Tuple[str, str, Dict[str, str]]] = {
    "browser": (
        "Ordinary desktop Chrome",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/130.0.0.0 Safari/537.36",
        {},
    ),
    "headless": (
        "Headless Chrome (automation)",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
        "HeadlessChrome/130.0.0.0 Safari/537.36",
        {},
    ),
    "gptbot": (
        "OpenAI GPTBot crawler",
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
        {},
    ),
    "chatgpt-user": (
        "ChatGPT acting for a user, with a Web Bot Auth Signature-Agent header",
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
        {"Signature-Agent": '"https://chatgpt.com"'},
    ),
    "claudebot": (
        "Anthropic ClaudeBot crawler",
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
        {},
    ),
    "perplexitybot": (
        "Perplexity crawler",
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; "
        "+https://perplexity.ai/perplexitybot)",
        {},
    ),
}

# A CAPTCHA actually rendered: its widget (data-sitekey) or its script. Asgardeo's
# login page always carries reCAPTCHA helper code, so the bare word is not enough.
CAPTCHA_PATTERN = re.compile(
    r"data-sitekey=|recaptcha/(?:api|enterprise)\.js|hcaptcha\.com/1/api\.js|challenges\.cloudflare\.com/turnstile",
    re.IGNORECASE,
)
REDIRECT_CODES = (301, 302, 303, 307, 308)


# --------------------------------------------------------------------------- config


def load_env_file(path: Path) -> None:
    """KEY=VALUE lines; existing environment variables win."""
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key.strip(), value)


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        sys.exit(f"error: {name} is not set (see .env.example)")
    return value


def default_allowed_hosts(base_host: str) -> List[str]:
    # api.wso2isdemo.com -> also accounts.wso2isdemo.com, where the login pages are served.
    labels = base_host.split(".")
    hosts = [base_host]
    if len(labels) > 2:
        hosts.append("accounts." + ".".join(labels[1:]))
    return hosts


# --------------------------------------------------------------------------- HTTP


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Redirects are followed by hand, so each hop can be shown and checked."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Page:
    def __init__(self, url: str, status: int, headers, body: bytes) -> None:
        self.url = url
        self.status = status
        self.headers = headers
        self.body = body
        self.text = body.decode("utf-8", errors="replace")
        self.redirected_to: Optional[str] = None  # a redirect that was reported but not followed

    @property
    def location(self) -> Optional[str]:
        value = self.headers.get("Location") if self.headers else None
        return urllib.parse.urljoin(self.url, value) if value else None


def short_url(url: str, limit: int = 110) -> str:
    parts = urllib.parse.urlsplit(url)
    text = parts.netloc + parts.path + (("?" + parts.query) if parts.query else "")
    return text if len(text) <= limit else text[: limit - 3] + "..."


class Session:
    def __init__(self, headers: Dict[str, str], allowed_hosts: List[str], redirect_uri: str) -> None:
        self.headers = headers
        self.allowed_hosts = [host.lower() for host in allowed_hosts]
        self.redirect_uri = redirect_uri
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()), NoRedirect()
        )
        self.step = 0

    def allowed(self, url: str) -> bool:
        parts = urllib.parse.urlsplit(url)
        return parts.scheme == "https" and (parts.hostname or "").lower() in self.allowed_hosts

    def is_redirect_uri(self, url: str) -> bool:
        target, home = urllib.parse.urlsplit(url), urllib.parse.urlsplit(self.redirect_uri)
        return (target.scheme, target.netloc, target.path.rstrip("/")) == (home.scheme, home.netloc, home.path.rstrip("/"))

    def request(self, method: str, url: str, form: Optional[Dict[str, str]] = None) -> Page:
        if not self.allowed(url):
            sys.exit(f"error: refusing to call {url}: only https://{' or '.join(self.allowed_hosts)} are allowed")

        headers = dict(self.headers)
        data = None
        if form is not None:
            data = urllib.parse.urlencode(form).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"

        request = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with self.opener.open(request, timeout=TIMEOUT_SECONDS) as response:
                page = Page(url, response.status, response.headers, response.read())
        except urllib.error.HTTPError as error:  # every non-2xx, redirects included
            page = Page(url, error.code, error.headers, error.read())
        except urllib.error.URLError as error:
            sys.exit(f"error: {method} {short_url(url)} failed: {error.reason}")

        self.step += 1
        size = f"{len(page.body) / 1024:.1f} KB"
        kind = (page.headers.get("Content-Type", "") if page.headers else "").split(";")[0]
        print(f"{self.step:>3}  {method:<4} {page.status}  {short_url(url)}")
        if page.status in REDIRECT_CODES and page.location:
            print(f"{'':>15}-> {short_url(page.location)}")
        else:
            print(f"{'':>15}{kind or 'no content type'}, {size}")
        return page

    def navigate(self, method: str, url: str, form: Optional[Dict[str, str]] = None) -> Page:
        page = self.request(method, url, form)
        for _ in range(MAX_REDIRECTS):
            target = page.location
            if page.status not in REDIRECT_CODES or not target:
                return page
            if self.is_redirect_uri(target):
                print(f"{'':>15}(back at the Wayfinder redirect URI: not followed)")
                page.redirected_to = target
                return page
            if not self.allowed(target):
                print(f"{'':>15}(outside the demo hosts: not followed)")
                page.redirected_to = target
                return page
            page = self.request("GET", target)
        sys.exit(f"error: more than {MAX_REDIRECTS} redirects")


# --------------------------------------------------------------------------- page analysis


class PageParser(HTMLParser):
    """Collects the title, the forms and their inputs, and visible error text."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.forms: List[Dict] = []
        self.errors: List[str] = []
        self._in_title = False
        self._error_depth = 0
        self._error_text: List[str] = []

    def handle_starttag(self, tag, attrs):
        attributes = {key: (value or "") for key, value in attrs}
        if tag == "title":
            self._in_title = True
        elif tag == "form":
            self.forms.append({"action": attributes.get("action", ""), "id": attributes.get("id", ""), "inputs": []})
        elif tag == "input" and self.forms:
            self.forms[-1]["inputs"].append(
                {
                    "name": attributes.get("name", ""),
                    "type": attributes.get("type", "text").lower(),
                    "value": attributes.get("value", ""),
                }
            )
        classes = attributes.get("class", "")
        if self._error_depth:
            self._error_depth += 1
        elif attributes.get("id") == "error-msg" or ("negative" in classes and "message" in classes):
            self._error_depth = 1
            self._error_text = []

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if self._error_depth:
            self._error_depth -= 1
            if self._error_depth == 0:
                text = " ".join(" ".join(self._error_text).split())
                if text:
                    self.errors.append(text)

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        if self._error_depth:
            self._error_text.append(data)


def parse_page(page: Page) -> PageParser:
    parser = PageParser()
    try:
        parser.feed(page.text)
    except Exception:  # a broken page should not stop the report
        pass
    return parser


def login_form(parsed: PageParser) -> Optional[Dict]:
    for form in parsed.forms:
        names = {field["name"] for field in form["inputs"]}
        types = {field["type"] for field in form["inputs"]}
        if "password" in types or names & {"username", "usernameUserInput"}:
            return form
    return None


def describe_form(form: Dict) -> str:
    types = {field["type"] for field in form["inputs"]}
    names = {field["name"] for field in form["inputs"]}
    has_user = bool(names & {"username", "usernameUserInput"})
    if "password" in types and has_user:
        return "username + password"
    if "password" in types:
        return "password only"
    return "username only (identifier first)"


def report(page: Page) -> None:
    query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(page.redirected_to or page.url).query))
    path = urllib.parse.urlsplit(page.redirected_to or page.url).path
    parsed = parse_page(page)
    print()

    if page.redirected_to:
        if "code" in query:
            print("Result: SIGNED IN - Asgardeo returned an authorization code (not exchanged)")
        elif "error" in query:
            print(f"Result: DENIED - redirected with error={query['error']}")
            if query.get("error_description"):
                print(f"  description: {query['error_description']}")
        else:
            print(f"Result: REDIRECTED to {short_url(page.redirected_to)}")
            for key, value in query.items():
                print(f"  {key}: {value}")
        return

    if page.status == 403:
        print("Result: BLOCKED - HTTP 403 (denied before the login page)")
    elif page.status == 429:
        print("Result: THROTTLED - HTTP 429")
    elif page.status >= 500:
        print(f"Result: SERVER ERROR - HTTP {page.status}")
    elif path.endswith("oauth2_error.do"):
        print("Result: OAUTH ERROR PAGE")
        for key in ("oauthErrorCode", "oauthErrorMsg"):
            if query.get(key):
                print(f"  {key}: {query[key]}")
    elif "retry.do" in path or "error.do" in path or query.get("status") or query.get("errorCode"):
        print("Result: DENIED - error page served")
        for key in ("status", "statusMsg", "errorCode", "errorMsg"):
            if query.get(key):
                print(f"  {key}: {query[key]}")
    elif CAPTCHA_PATTERN.search(page.text):
        print("Result: CHALLENGE - the page carries a CAPTCHA")
    elif path.endswith("login.do"):
        print("Result: LOGIN PAGE served (no challenge detected)")
    elif "/authenticationendpoint/" in path:
        print(f"Result: AUTHENTICATOR PAGE - {path.rsplit('/', 1)[-1]} (a further step, e.g. a step-up)")
    else:
        print(f"Result: HTTP {page.status} page at {short_url(page.url)}")

    if query.get("authenticators"):
        print(f"  authenticators: {query['authenticators']}")
    if query.get("authFailure") == "true":
        print(f"  login failed: {query.get('authFailureMsg', 'no message')}")
    if parsed.title.strip():
        print(f"  page title: {' '.join(parsed.title.split())}")
    for message in parsed.errors[:3]:
        print(f"  message on page: {message}")
    form = login_form(parsed)
    if form:
        print(f"  form: {describe_form(form)}")


# --------------------------------------------------------------------------- flow


def authorize_url(base_url: str, client_id: str, redirect_uri: str, scopes: str) -> str:
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    params = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": scopes,
        "state": secrets.token_urlsafe(16),
        "nonce": secrets.token_urlsafe(16),
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    return f"{base_url}/oauth2/authorize?{urllib.parse.urlencode(params)}"


def submit_credentials(session: Session, page: Page, username: str, password: str) -> Page:
    """Fills the login form (username + password, or identifier first then password)."""
    for _ in range(2):
        form = login_form(parse_page(page))
        if not form:
            break
        data: Dict[str, str] = {}
        sent_password = False
        for field in form["inputs"]:
            name, kind = field["name"], field["type"]
            if not name or kind in ("submit", "button", "checkbox", "radio"):
                continue
            if name in ("username", "usernameUserInput"):
                data[name] = username
            elif kind == "password":
                data[name] = password
                sent_password = True
            else:
                data[name] = field["value"]
        print(f"\n-- submitting {describe_form(form)} for {username}")
        page = session.navigate("POST", urllib.parse.urljoin(page.url, form["action"] or page.url), data)
        if sent_password:
            break
    return page


def save_html(path: Optional[Path], page: Page) -> None:
    if path:
        path.write_bytes(page.body)
        print(f"  saved the page to {path}")


def parse_header(value: str) -> Tuple[str, str]:
    if ":" not in value:
        raise argparse.ArgumentTypeError(f"expected 'Name: value', got {value!r}")
    name, header_value = value.split(":", 1)
    return name.strip(), header_value.strip()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Replay the Wayfinder sign-in with an AI-agent user agent and headers (one request sequence).",
    )
    parser.add_argument("--preset", choices=sorted(PRESETS), default="gptbot", help="User-Agent preset (default: gptbot)")
    parser.add_argument("--user-agent", help="custom User-Agent (overrides the preset's)")
    parser.add_argument(
        "-H", "--header", action="append", type=parse_header, default=[],
        help="extra header, e.g. -H 'X-Agent-Id: trip-planner'; repeatable",
    )
    parser.add_argument("--login", action="store_true", help="also submit REPLAY_USERNAME / REPLAY_PASSWORD (a test user)")
    parser.add_argument("--env-file", type=Path, help="env file to load (default: .env next to this script, if present)")
    parser.add_argument("--list-presets", action="store_true", help="show the presets and exit")
    parser.add_argument("--dry-run", action="store_true", help="print the request without sending it")
    parser.add_argument("--save-html", type=Path, help="write the last page's HTML to this file")
    args = parser.parse_args()

    if args.list_presets:
        for name in sorted(PRESETS):
            description, user_agent, extra = PRESETS[name]
            print(f"{name:<14} {description}\n{'':<14} User-Agent: {user_agent}")
            for key, value in extra.items():
                print(f"{'':<14} {key}: {value}")
        return

    env_file = args.env_file or Path(__file__).resolve().with_name(".env")
    if env_file.is_file():
        load_env_file(env_file)

    base_url = required_env("ASGARDEO_BASE_URL").rstrip("/")
    client_id = required_env("WAYFINDER_CLIENT_ID")
    redirect_uri = required_env("WAYFINDER_REDIRECT_URI")
    scopes = os.environ.get("REPLAY_SCOPES", "").strip() or "openid profile"
    base_host = urllib.parse.urlsplit(base_url).hostname or ""
    allowed_hosts = [h.strip() for h in os.environ.get("REPLAY_ALLOWED_HOSTS", "").split(",") if h.strip()]
    allowed_hosts = allowed_hosts or default_allowed_hosts(base_host)

    description, preset_agent, preset_headers = PRESETS[args.preset]
    headers = {
        "User-Agent": args.user_agent or preset_agent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        **preset_headers,
        **dict(args.header),
    }
    url = authorize_url(base_url, client_id, redirect_uri, scopes)

    print("Wayfinder agent replay")
    print(f"  target:  {base_url}  (client {client_id}, redirect {redirect_uri})")
    print(f"  preset:  {args.preset} - {description}" + (" (User-Agent overridden)" if args.user_agent else ""))
    for name, value in headers.items():
        if name not in ("Accept", "Accept-Language"):
            print(f"  {name}: {value}")
    print(f"  allowed hosts: {', '.join(allowed_hosts)}\n")

    if args.dry_run:
        print(f"GET {url}")
        return

    session = Session(headers, allowed_hosts, redirect_uri)
    page = session.navigate("GET", url)
    report(page)
    save_html(args.save_html, page)

    if args.login:
        username = required_env("REPLAY_USERNAME")
        password = os.environ.get("REPLAY_PASSWORD") or getpass.getpass(f"Password for {username}: ")
        if page.redirected_to or not login_form(parse_page(page)):
            print("\n--login: no login form on the last page, nothing submitted")
            return
        page = submit_credentials(session, page, username, password)
        report(page)
        save_html(args.save_html, page)


if __name__ == "__main__":
    main()
