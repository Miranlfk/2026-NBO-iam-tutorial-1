"""
 Copyright (c) 2025, WSO2 LLC. (http://www.wso2.com). All Rights Reserved.

  LLM selection

  LLM_PROVIDER picks the chat model the agent runs on:

  - gemini (default): Google Gemini with GOOGLE_API_KEY.
  - openai: OpenAI with OPENAI_API_KEY.
  - openai-compatible: any OpenAI chat-completions endpoint that expects an
    OAuth2 client-credentials bearer token, such as the WSO2 API Manager AI
    gateway. The token is fetched from LLM_TOKEN_URL with LLM_CLIENT_ID and
    LLM_CLIENT_SECRET, cached, renewed shortly before it expires, and renewed
    once more if the gateway still answers 401.
"""

import logging
import os
import threading
import time
from typing import Optional

import httpx
import openai
from langchain_openai import ChatOpenAI
from pydantic import PrivateAttr

logger = logging.getLogger(__name__)

DEFAULT_MODELS = {
    "gemini": "gemini-3.1-flash-lite-flash",
    "openai": "gpt-4o",
    "openai-compatible": "gpt-5.2",
}

TOKEN_REFRESH_SKEW_SECONDS = 60


def _required_env(key: str) -> str:
    value = os.getenv(key, "").strip()
    if not value:
        raise ValueError(f"Missing required environment variable: {key}")
    return value


def _optional_float(key: str) -> Optional[float]:
    value = os.getenv(key, "").strip()
    return float(value) if value else None


def _optional_int(key: str) -> Optional[int]:
    value = os.getenv(key, "").strip()
    return int(value) if value else None


class ClientCredentialsTokenProvider:
    """Fetches and caches an OAuth2 client-credentials access token.

    Callable with no arguments, so it can be handed to the OpenAI client as its
    api_key: the client asks for the key before every request, and this returns
    the cached token until it is close to expiry.
    """

    def __init__(
        self,
        token_url: str,
        client_id: str,
        client_secret: str,
        scope: Optional[str] = None,
        refresh_skew_seconds: int = TOKEN_REFRESH_SKEW_SECONDS,
    ):
        self._token_url = token_url
        self._client_id = client_id
        self._client_secret = client_secret
        self._scope = scope or None
        self._refresh_skew_seconds = refresh_skew_seconds
        self._verify = os.getenv("DISABLE_SSL_VERIFY", "").lower() != "true"
        self._lock = threading.Lock()
        self._token: Optional[str] = None
        self._expires_at = 0.0

    def _is_valid(self) -> bool:
        return bool(self._token) and time.time() < self._expires_at - self._refresh_skew_seconds

    def _fetch(self) -> str:
        data = {"grant_type": "client_credentials"}
        if self._scope:
            data["scope"] = self._scope

        with httpx.Client(timeout=30, verify=self._verify) as client:
            response = client.post(
                self._token_url,
                data=data,
                auth=(self._client_id, self._client_secret),
                headers={"Accept": "application/json"},
            )

        if response.status_code >= 400:
            raise RuntimeError(
                f"LLM token request failed: {response.status_code} {response.text[:300]}"
            )

        payload = response.json()
        token = payload.get("access_token")
        if not token:
            raise RuntimeError("LLM token response did not include access_token")

        expires_in = float(payload.get("expires_in") or 3600)
        self._token = token
        self._expires_at = time.time() + expires_in
        logger.info("Obtained LLM gateway token (expires in %ss)", int(expires_in))
        return token

    def __call__(self) -> str:
        if self._is_valid():
            return self._token  # type: ignore[return-value]
        with self._lock:
            if self._is_valid():
                return self._token  # type: ignore[return-value]
            return self._fetch()

    def invalidate(self) -> None:
        with self._lock:
            self._token = None
            self._expires_at = 0.0


class ClientCredentialsChatOpenAI(ChatOpenAI):
    """ChatOpenAI that renews its bearer token and retries once on a 401.

    Only the single model request is retried, never the agent run, so a tool
    call that already happened is not repeated.
    """

    _token_provider: Optional[ClientCredentialsTokenProvider] = PrivateAttr(default=None)

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        try:
            return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)
        except openai.AuthenticationError:
            if self._token_provider is None:
                raise
            logger.warning("LLM gateway rejected the token; renewing it and retrying once")
            self._token_provider.invalidate()
            return super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        try:
            return await super()._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs)
        except openai.AuthenticationError:
            if self._token_provider is None:
                raise
            logger.warning("LLM gateway rejected the token; renewing it and retrying once")
            self._token_provider.invalidate()
            return await super()._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs)


def _chat_completions_base_url(url: str) -> str:
    """The OpenAI client appends /chat/completions itself; accept either form."""
    url = url.strip().rstrip("/")
    suffix = "/chat/completions"
    return url[: -len(suffix)] if url.endswith(suffix) else url


def _create_openai_compatible(model: str, temperature: Optional[float], max_tokens: Optional[int]):
    token_provider = ClientCredentialsTokenProvider(
        token_url=_required_env("LLM_TOKEN_URL"),
        client_id=_required_env("LLM_CLIENT_ID"),
        client_secret=_required_env("LLM_CLIENT_SECRET"),
        scope=os.getenv("LLM_TOKEN_SCOPE", "").strip() or None,
    )
    kwargs = {
        "model": model,
        "base_url": _chat_completions_base_url(_required_env("LLM_BASE_URL")),
        "api_key": token_provider,
        # The gateway exposes chat completions only.
        "use_responses_api": False,
    }
    # Some models (gpt-5.x) accept only the default temperature, so it is sent
    # only when configured. max_tokens goes out as max_completion_tokens.
    if temperature is not None:
        kwargs["temperature"] = temperature
    if max_tokens is not None:
        kwargs["max_tokens"] = max_tokens

    llm = ClientCredentialsChatOpenAI(**kwargs)
    llm._token_provider = token_provider
    return llm


def create_llm():
    """Build the chat model selected by LLM_PROVIDER."""
    provider = os.getenv("LLM_PROVIDER", "gemini").strip().lower() or "gemini"
    if provider not in DEFAULT_MODELS:
        raise ValueError(
            f"Unsupported LLM_PROVIDER '{provider}'. Use one of: {', '.join(DEFAULT_MODELS)}"
        )

    model = os.getenv("MODEL_NAME", "").strip() or DEFAULT_MODELS[provider]
    temperature = _optional_float("LLM_TEMPERATURE")
    max_tokens = _optional_int("LLM_MAX_COMPLETION_TOKENS")
    logger.info("LLM provider: %s, model: %s", provider, model)

    if provider == "openai-compatible":
        return _create_openai_compatible(model, temperature, max_tokens)

    if provider == "openai":
        kwargs = {"model": model, "api_key": _required_env("OPENAI_API_KEY")}
        if temperature is not None:
            kwargs["temperature"] = temperature
        if max_tokens is not None:
            kwargs["max_tokens"] = max_tokens
        return ChatOpenAI(**kwargs)

    from langchain_google_genai import ChatGoogleGenerativeAI

    return ChatGoogleGenerativeAI(
        model=model,
        temperature=0.7 if temperature is None else temperature,
    )
