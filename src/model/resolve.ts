/**
 * nimblebrain-agent's model resolution: a `provider:model` string to a language model,
 * keyed from the environment the process was given.
 *
 * Each provider takes its key from its usual variable and an optional base
 * URL, so a host can point nimblebrain-agent at a gateway that holds the real keys and
 * meters the calls, with no change here.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { createXai } from "@ai-sdk/xai";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
import { wrapFetchWithLiveness } from "./fetch-liveness.ts";

/**
 * A session's own access to a model: `credential` is a bearer the client
 * handed the session (a gateway's per-turn credential), presented in place of
 * the process's provider key. The calls go to `endpoints[provider]` when the
 * client named one for the call's provider, else to `endpoint`, else to the
 * process's own. An endpoint exists only beside a credential, so a client can
 * never send the process's key to an address it chose. A session without its
 * own access uses the process's key and endpoint.
 */
export interface ModelAccess {
  credential: string;
  endpoint?: string;
  endpoints?: Record<string, string>;
}

export type ModelResolver = (model: string, access?: ModelAccess) => LanguageModelV4;

type Env = Record<string, string | undefined>;

/** The providers nimblebrain-agent speaks, by the provider half of a model string. */
export const PROVIDERS = ["anthropic", "openai", "google", "xai", "nebius", "greenpt"] as const;

/** GreenPT's OpenAI-compatible endpoint. */
const GREENPT_BASE_URL = "https://api.greenpt.ai/v1";

/** Nebius Token Factory's OpenAI-compatible endpoint. */
const NEBIUS_BASE_URL = "https://api.tokenfactory.nebius.com/v1";

/**
 * The key a provider's client is built with when the session's credential
 * stands in for it. The client needs one; {@link credentialFetch} removes it
 * from every request.
 */
const SESSION_CREDENTIAL_KEY = "session-credential";

/** The headers provider clients carry a key in. */
const KEY_HEADERS = ["x-api-key", "x-goog-api-key", "authorization"];

/**
 * The fetch a session's calls go through when it has its own credential: every
 * header a provider client puts its key in is removed, and the credential goes
 * as `Authorization: Bearer`, whichever provider the call is for.
 */
function credentialFetch(credential: string, base: typeof fetch = globalThis.fetch): typeof fetch {
  const withCredential = (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    for (const name of KEY_HEADERS) headers.delete(name);
    headers.set("authorization", `Bearer ${credential}`);
    return base(input, { ...init, headers });
  };
  return Object.assign(withCredential, { preconnect: base.preconnect }) as typeof fetch;
}

export function createModelResolver(env: Env = process.env): ModelResolver {
  const cache = new Map<string, LanguageModelV4>();
  return (model, access) => {
    // A session's own credential is never cached: it lives as long as the session.
    if (access) return resolveModel(model, env, access);
    const cached = cache.get(model);
    if (cached) return cached;
    const resolved = resolveModel(model, env);
    cache.set(model, resolved);
    return resolved;
  };
}

/** How one provider's client is keyed and where it calls. */
interface ClientAccess {
  apiKey: string;
  baseURL?: string;
  fetch?: typeof fetch;
}

/**
 * One provider's key, base URL and fetch: the session's credential when it has
 * its own access, else the process's key. The base URL is the session's
 * endpoint for the provider when it named one, else the process's variable.
 */
function clientAccess(
  env: Env,
  vars: { key: string; baseURL: string },
  endpoint: string | undefined,
  access: ModelAccess | undefined,
): ClientAccess {
  const baseURL = endpoint ?? env[vars.baseURL];
  const where = baseURL ? { baseURL } : {};
  if (access) {
    return { apiKey: SESSION_CREDENTIAL_KEY, ...where, fetch: credentialFetch(access.credential) };
  }
  return { apiKey: required(env, vars.key), ...where };
}

function resolveModel(model: string, env: Env, access?: ModelAccess): LanguageModelV4 {
  const separator = model.indexOf(":");
  if (separator < 0)
    throw new Error(`Model "${model}" names no provider (expected provider:model)`);
  const provider = model.slice(0, separator);
  const modelId = model.slice(separator + 1);
  const endpoint = access ? (access.endpoints?.[provider] ?? access.endpoint) : undefined;
  const client = (key: string, baseURL: string) =>
    clientAccess(env, { key, baseURL }, endpoint, access);
  switch (provider) {
    case "anthropic": {
      const { fetch: base, ...keyed } = client("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL");
      const anthropic = createAnthropic({
        ...keyed,
        // Re-arms the stream watchdog on Anthropic's keep-alive pings (fetch-liveness.ts).
        fetch: wrapFetchWithLiveness(base ?? globalThis.fetch) as typeof fetch,
      });
      // Tool arguments are validated by the API before they stream.
      return wrapLanguageModel({
        model: anthropic.languageModel(modelId),
        middleware: defaultSettingsMiddleware({
          settings: { providerOptions: { anthropic: { toolStreaming: false } } },
        }),
      });
    }
    case "openai":
      return createOpenAI(client("OPENAI_API_KEY", "OPENAI_BASE_URL")).languageModel(modelId);
    case "google":
      return createGoogleGenerativeAI(
        client("GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_GENERATIVE_AI_BASE_URL"),
      ).languageModel(modelId);
    // Chat Completions, named rather than the adapter's default, which has moved
    // between adapter majors.
    case "xai":
      return createXai(client("XAI_API_KEY", "XAI_BASE_URL")).chat(modelId);
    // OpenAI-compatible APIs, built with the adapter for exactly that. Each asks
    // for streamed usage (without it every call meters at zero) and keeps a
    // response format's schema.
    case "nebius": {
      const { baseURL, ...rest } = client("NEBIUS_API_KEY", "NEBIUS_BASE_URL");
      return createOpenAICompatible({
        name: "nebius",
        ...rest,
        baseURL: baseURL ?? NEBIUS_BASE_URL,
        includeUsage: true,
        supportsStructuredOutputs: true,
      }).languageModel(modelId);
    }
    case "greenpt": {
      const { baseURL, ...rest } = client("GREENPT_API_KEY", "GREENPT_BASE_URL");
      return createOpenAICompatible({
        name: "greenpt",
        ...rest,
        baseURL: baseURL ?? GREENPT_BASE_URL,
        includeUsage: true,
        supportsStructuredOutputs: true,
      }).languageModel(modelId);
    }
    default:
      throw new Error(`nimblebrain-agent has no provider "${provider}" (${PROVIDERS.join(", ")})`);
  }
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
