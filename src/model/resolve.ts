/**
 * nimblebrain-agent's model resolution: a `provider:model` string to a language model,
 * keyed from the environment the process was given.
 *
 * Each provider takes its key from its usual variable and an optional base
 * URL, so a host can point nimblebrain-agent at a gateway that holds the real keys and
 * meters the calls, with no change here. The providers are built as
 * NimbleBrain's native engine builds them, so a call behaves the same in both.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
import { wrapFetchWithLiveness } from "./fetch-liveness.ts";

export type ModelResolver = (model: string) => LanguageModelV4;

type Env = Record<string, string | undefined>;

export function createModelResolver(env: Env = process.env): ModelResolver {
  const cache = new Map<string, LanguageModelV4>();
  return (model) => {
    const cached = cache.get(model);
    if (cached) return cached;
    const resolved = resolveModel(model, env);
    cache.set(model, resolved);
    return resolved;
  };
}

function resolveModel(model: string, env: Env): LanguageModelV4 {
  const separator = model.indexOf(":");
  if (separator < 0)
    throw new Error(`Model "${model}" names no provider (expected provider:model)`);
  const provider = model.slice(0, separator);
  const modelId = model.slice(separator + 1);
  switch (provider) {
    case "anthropic": {
      const anthropic = createAnthropic({
        apiKey: required(env, "ANTHROPIC_API_KEY"),
        ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
        // Re-arms the stream watchdog on Anthropic's keep-alive pings (fetch-liveness.ts).
        fetch: wrapFetchWithLiveness(globalThis.fetch) as typeof fetch,
      });
      // Tool arguments validated by the API before they stream, as the native engine runs it.
      return wrapLanguageModel({
        model: anthropic.languageModel(modelId),
        middleware: defaultSettingsMiddleware({
          settings: { providerOptions: { anthropic: { toolStreaming: false } } },
        }),
      });
    }
    case "openai":
      return createOpenAI({
        apiKey: required(env, "OPENAI_API_KEY"),
        ...(env.OPENAI_BASE_URL ? { baseURL: env.OPENAI_BASE_URL } : {}),
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
