/**
 * nimblebrain-agent's model resolution: a `provider:model` string to a language model,
 * keyed from the environment the process was given.
 *
 * Each provider takes its key from its usual variable and an optional base
 * URL, so a host can point nimblebrain-agent at a gateway that holds the real keys and
 * meters the calls, with no change here.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
import { wrapFetchWithLiveness } from "./fetch-liveness.ts";

/**
 * How a session's model calls authenticate, and where they go. `credential`
 * is a bearer the client handed the session (a gateway's per-turn
 * credential), presented in place of the process's provider key; absent, the
 * provider key is used. `endpoint` is the base URL the session's calls go to,
 * in place of the process's; it is taken only beside a credential of the
 * session's own, so a client can never send the process's key to an address
 * it chose.
 */
export interface ModelAccess {
  credential?: string;
  endpoint?: string;
}

export type ModelResolver = (model: string, access?: ModelAccess) => LanguageModelV4;

type Env = Record<string, string | undefined>;

export function createModelResolver(env: Env = process.env): ModelResolver {
  const cache = new Map<string, LanguageModelV4>();
  return (model, access) => {
    // A session's own credential is never cached: it lives as long as the session.
    if (access?.credential) return resolveModel(model, env, access);
    const cached = cache.get(model);
    if (cached) return cached;
    const resolved = resolveModel(model, env);
    cache.set(model, resolved);
    return resolved;
  };
}

function resolveModel(model: string, env: Env, access: ModelAccess = {}): LanguageModelV4 {
  const { credential } = access;
  const endpoint = credential ? access.endpoint : undefined;
  const separator = model.indexOf(":");
  if (separator < 0)
    throw new Error(`Model "${model}" names no provider (expected provider:model)`);
  const provider = model.slice(0, separator);
  const modelId = model.slice(separator + 1);
  switch (provider) {
    case "anthropic": {
      const anthropic = createAnthropic({
        // A bearer credential goes as `Authorization: Bearer`, the gateway's scheme.
        ...(credential
          ? { authToken: credential }
          : { apiKey: required(env, "ANTHROPIC_API_KEY") }),
        ...((endpoint ?? env.ANTHROPIC_BASE_URL)
          ? { baseURL: endpoint ?? env.ANTHROPIC_BASE_URL }
          : {}),
        // Re-arms the stream watchdog on Anthropic's keep-alive pings (fetch-liveness.ts).
        fetch: wrapFetchWithLiveness(globalThis.fetch) as typeof fetch,
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
      return createOpenAI({
        apiKey: credential ?? required(env, "OPENAI_API_KEY"),
        ...((endpoint ?? env.OPENAI_BASE_URL) ? { baseURL: endpoint ?? env.OPENAI_BASE_URL } : {}),
      }).languageModel(modelId);
    default:
      throw new Error(`nimblebrain-agent has no provider "${provider}" (anthropic, openai)`);
  }
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
