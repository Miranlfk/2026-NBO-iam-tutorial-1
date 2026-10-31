/*
Copyright (c) 2026, WSO2 LLC. (http://www.wso2.com). All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

/**
 * OAuth2 client-credentials bearer auth for an OpenAI-compatible LLM gateway
 * (for example the WSO2 API Manager AI gateway). The token is cached, renewed a
 * minute before it expires, and renewed once more if the gateway answers 401.
 */

const TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

export type ClientCredentialsOptions = {
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    scope?: string;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class ClientCredentialsTokenProvider {
    private cached: { accessToken: string; expiresAtMs: number } | null = null;
    private pending: Promise<string> | null = null;

    constructor(private readonly options: ClientCredentialsOptions) {}

    /** A valid token, fetched at most once at a time across concurrent callers. */
    async getToken(): Promise<string> {
        if (this.cached && Date.now() < this.cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS) {
            return this.cached.accessToken;
        }

        if (!this.pending) {
            this.pending = this.fetchToken().finally(() => {
                this.pending = null;
            });
        }

        return this.pending;
    }

    /** Drop the cached token, unless another caller has already replaced it. */
    invalidate(token?: string) {
        if (!token || this.cached?.accessToken === token) {
            this.cached = null;
        }
    }

    private async fetchToken() {
        const { tokenUrl, clientId, clientSecret, scope } = this.options;
        const body = new URLSearchParams({ grant_type: "client_credentials" });

        if (scope) {
            body.set("scope", scope);
        }

        const response = await fetch(tokenUrl, {
            method: "POST",
            headers: {
                Accept: "application/json",
                Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: body.toString(),
        });
        const data = await response.json().catch(() => ({})) as Record<string, unknown>;

        if (!response.ok || typeof data.access_token !== "string" || !data.access_token) {
            const reason = typeof data.error === "string" ? `: ${data.error}` : "";

            throw new Error(`LLM token request failed with ${response.status}${reason}`);
        }

        const expiresIn = Number(data.expires_in) > 0 ? Number(data.expires_in) : DEFAULT_TOKEN_LIFETIME_SECONDS;

        this.cached = {
            accessToken: data.access_token,
            expiresAtMs: Date.now() + (expiresIn * 1000),
        };

        return data.access_token;
    }
}

/**
 * A fetch for the OpenAI client that sets the gateway bearer token on every
 * request and, on a 401, renews the token and sends the same request once more.
 */
export function createClientCredentialsFetch(
    tokenProvider: ClientCredentialsTokenProvider,
    baseFetch: FetchLike = fetch,
): FetchLike {
    return async (input, init) => {
        const send = (token: string) => {
            const headers = new Headers(init?.headers);

            headers.set("Authorization", `Bearer ${token}`);

            return baseFetch(input, { ...init, headers });
        };

        const token = await tokenProvider.getToken();
        const response = await send(token);

        if (response.status !== 401) {
            return response;
        }

        tokenProvider.invalidate(token);
        await response.body?.cancel().catch(() => undefined);

        return send(await tokenProvider.getToken());
    };
}

/** The OpenAI client appends /chat/completions itself; accept either form. */
export function toChatCompletionsBaseUrl(url: string) {
    const trimmed = url.trim().replace(/\/+$/, "");

    return trimmed.endsWith("/chat/completions")
        ? trimmed.slice(0, -"/chat/completions".length)
        : trimmed;
}
