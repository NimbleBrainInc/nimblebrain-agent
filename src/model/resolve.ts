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
 * Where one provider's calls go and the headers they carry, as a client set it
 * with ACP's `providers/set`. The headers are the call's whole authorization:
 * none of the process's keys go with it, and empty headers send none.
 */
export interface ProviderRoute {
  baseUrl: string;
  headers: Record<string, string>;
}

/**
 * A session's own access to its models.
 *
 * - `providers`: what the client set per provider over ACP (`providers/set`,
 *   `providers/disable`), ahead of everything below. A route sends the
 *   provider's calls to its base URL with its headers alone; `null` is a
 *   provider the client turned off, which refuses every call.
 * - `credential`: a bearer the client handed the session in its options (a
 *   gateway's per-turn credential), presented in place of the process's key.
 *   Its calls go to `endpoints[provider]` when the client named one, else to
 *   `endpoint`, else to the process's own. An endpoint exists only beside a
 *   credential, so a client can never send the process's key to an address it
 *   chose.
 *
 * Whatever the session's access leaves out uses the process's key and endpoint.
 */
export interface ModelAccess {
  providers?: Record<string, ProviderRoute | null>;
  credential?: string;
  endpoint?: string;
  endpoints?: Record<string, string>;
}

export type ModelResolver = (model: string, access?: ModelAccess) => LanguageModelV4;

type Env = Record<string, string | undefined>;

/** The providers nimblebrain-agent speaks, by the provider half of a model string. */
export const PROVIDERS = ["anthropic", "openai", "google", "xai", "nebius", "greenpt"] as const;

/**
 * Each provider's API protocol, in ACP's `providers/*` terms. xAI, Nebius and
 * GreenPT speak OpenAI's API; Gemini's has no well-known name, so it is named.
 */
export const PROVIDER_PROTOCOLS: Record<(typeof PROVIDERS)[number], string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "gemini",
  xai: "openai",
  nebius: "openai",
  greenpt: "openai",
};

/** Where each provider's calls go when neither the session nor the process says. */
const DEFAULT_BASE_URLS: Record<(typeof PROVIDERS)[number], string> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  xai: "https://api.x.ai/v1",
  nebius: "https://api.tokenfactory.nebius.com/v1",
  greenpt: "https://api.greenpt.ai/v1",
};

/** The variable that names each provider's base URL in the process's environment. */
const BASE_URL_VARS: Record<(typeof PROVIDERS)[number], string> = {
  anthropic: "ANTHROPIC_BASE_URL",
  openai: "OPENAI_BASE_URL",
  google: "GOOGLE_GENERATIVE_AI_BASE_URL",
  xai: "XAI_BASE_URL",
  nebius: "NEBIUS_BASE_URL",
  greenpt: "GREENPT_BASE_URL",
};

/** Where a provider's calls go on the process's own configuration. */
export function processBaseUrl(provider: (typeof PROVIDERS)[number], env: Env): string {
  return env[BASE_URL_VARS[provider]] ?? DEFAULT_BASE_URLS[provider];
}

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
 * The fetch a provider's calls go through on a route the client set: every
 * header a provider client puts its key in is removed, and the route's headers
 * are set, so the call carries the client's authorization and nothing else.
 */
function routeFetch(route: ProviderRoute, base: typeof fetch = globalThis.fetch): typeof fetch {
  const withRoute = (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    for (const name of KEY_HEADERS) headers.delete(name);
    for (const [name, value] of Object.entries(route.headers)) headers.set(name, value);
    return base(input, { ...init, headers });
  };
  return Object.assign(withRoute, { preconnect: base.preconnect }) as typeof fetch;
}

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
 * One provider's key, base URL and fetch: the client's route for the provider
 * when it set one, else the session's credential when it has one, else the
 * process's key. With the credential, the base URL is the session's endpoint
 * for the provider when it named one, else the process's variable.
 */
function clientAccess(
  env: Env,
  vars: { key: string; baseURL: string },
  provider: string,
  access: ModelAccess | undefined,
): ClientAccess {
  const route = access?.providers?.[provider];
  if (route === null) {
    throw new Error(`Provider "${provider}" is disabled for this session (providers/disable)`);
  }
  if (route) {
    return { apiKey: SESSION_CREDENTIAL_KEY, baseURL: route.baseUrl, fetch: routeFetch(route) };
  }
  const endpoint = access?.credential
    ? (access.endpoints?.[provider] ?? access.endpoint)
    : undefined;
  const baseURL = endpoint ?? env[vars.baseURL];
  const where = baseURL ? { baseURL } : {};
  if (access?.credential) {
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
  const client = (key: string, baseURL: string) =>
    clientAccess(env, { key, baseURL }, provider, access);
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
