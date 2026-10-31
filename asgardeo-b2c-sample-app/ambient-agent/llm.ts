import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import {
    ClientCredentialsTokenProvider,
    createClientCredentialsFetch,
    toChatCompletionsBaseUrl,
} from "./llm-gateway-auth.js";

export type LlmProvider = "gemini" | "openai" | "claude" | "deepseek" | "openai-compatible";

/**
 * Read when called rather than at import, so values agent.ts loads from .env
 * (after its imports run) are honoured.
 */
export function getLlmProvider() {
    return (process.env.LLM_PROVIDER || "gemini").toLowerCase() as LlmProvider;
}

function requiredEnv(name: string) {
    const value = process.env[name]?.trim();

    if (!value) {
        throw new Error(`${name} is required when LLM_PROVIDER=${getLlmProvider()}.`);
    }

    return value;
}

function optionalNumberEnv(name: string) {
    const value = process.env[name]?.trim();

    return value ? Number(value) : undefined;
}

/**
 * An OpenAI chat-completions endpoint behind an OAuth2 client-credentials
 * gateway (for example the WSO2 API Manager AI gateway). The custom fetch adds
 * the bearer token; the apiKey is only a placeholder the client requires.
 */
function createOpenAICompatibleModel() {
    const tokenProvider = new ClientCredentialsTokenProvider({
        tokenUrl: requiredEnv("LLM_TOKEN_URL"),
        clientId: requiredEnv("LLM_CLIENT_ID"),
        clientSecret: requiredEnv("LLM_CLIENT_SECRET"),
        scope: process.env.LLM_TOKEN_SCOPE?.trim() || undefined,
    });
    // Some models (gpt-5.x) accept only the default temperature, so it is sent
    // only when configured. LangChain sends the token cap as
    // max_completion_tokens for gpt-5.x and o-series model names.
    const temperature = optionalNumberEnv("LLM_TEMPERATURE");
    const maxCompletionTokens = optionalNumberEnv("LLM_MAX_COMPLETION_TOKENS");

    return new ChatOpenAI({
        apiKey: "client-credentials",
        model: process.env.MODEL_NAME || "gpt-5.2",
        // The gateway exposes chat completions only.
        useResponsesApi: false,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxCompletionTokens !== undefined ? { maxTokens: maxCompletionTokens } : {}),
        configuration: {
            baseURL: toChatCompletionsBaseUrl(requiredEnv("LLM_BASE_URL")),
            fetch: createClientCredentialsFetch(tokenProvider),
        },
    });
}

export function createLlmModel() {
    switch (getLlmProvider()) {
        case "openai-compatible":
            return createOpenAICompatibleModel();
        case "openai":
            return new ChatOpenAI({
                apiKey: process.env.OPENAI_API_KEY || "",
                model: process.env.MODEL_NAME || "gpt-4o",
            });
        case "claude":
            return new ChatAnthropic({
                apiKey: process.env.ANTHROPIC_API_KEY || "",
                model: process.env.MODEL_NAME || "claude-opus-4-7",
            });
        case "deepseek":
            return new ChatOpenAI({
                apiKey: process.env.DEEPSEEK_API_KEY || "",
                model: process.env.MODEL_NAME || "deepseek-chat",
                configuration: {
                    baseURL: "https://api.deepseek.com/v1",
                },
            });
        default:
            return new ChatGoogleGenerativeAI({
                apiKey: process.env.GOOGLE_API_KEY || "",
                model: process.env.MODEL_NAME || "gemini-3.1-flash-lite",
            });
    }
}

export type LlmModel = ReturnType<typeof createLlmModel>;

export const bindingMessageAgentPrompt = [
    "You are Wayfinder's ambient CIBA message agent.",
    "Your only job is to write concise CIBA binding messages for better-flight approval requests.",
    "Do not call tools. Do not make booking decisions. Do not invent facts.",
    "Use only the supplied JSON data.",
    "Each message must clearly state the route, airline if present, departure time/date if present, new price, savings if present, and that the existing booking will be canceled if approved.",
    "Never include booking IDs, consent IDs, auth request IDs, access tokens, or raw technical identifiers.",
    "Keep each bindingMessage under 220 characters.",
    "Return only valid JSON in this exact shape: {\"messages\":[{\"bookingId\":\"...\",\"bindingMessage\":\"...\"}]}",
].join("\n");

export function createBindingMessageAgent(llmModel: LlmModel) {
    return createReactAgent({
        llm: llmModel,
        tools: [],
        prompt: bindingMessageAgentPrompt,
    });
}

export type BindingMessageAgent = ReturnType<typeof createBindingMessageAgent>;
