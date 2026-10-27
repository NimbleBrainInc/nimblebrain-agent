/**
 * nimblebrain-agent's context management for one turn: what keeps the working history
 * inside the model's window while the loop runs.
 *
 * Two mechanisms: windowing on every model call (`transformContext`, with the provider's
 * reasoning replay policy), and a mid-turn fold that summarizes older history
 * when the turn outgrows its budget (`rewriteHistory`). The fold runs only when
 * the session allows it, and its summary is written by the session's summarizer
 * (`summarizer`), whose usage is reported with the turn's.
 */

import type { LanguageModelV4 } from "@ai-sdk/provider";
import { summarizeMessages } from "../conversation/compaction.ts";
import { applyReasoningReplayPolicy, windowMessages } from "../conversation/window.ts";
import type { EngineHooks, ToolSchema } from "../engine/types.ts";
import { getModelByString, getProviderFromModel } from "../model/catalog.ts";
import { buildMidTurnCompaction } from "../runtime/mid-turn-compaction.ts";
import { resolveMessageBudget } from "../runtime/resolve-message-budget.ts";
import type { TokenUsage } from "../usage/types.ts";

export interface TurnContext {
  model: string;
  system: string;
  tools: ToolSchema[];
  maxInputTokens: number;
  maxOutputTokens: number;
  /** Who writes a fold's summary; absent, the turn never folds. */
  summarizer?: {
    model: string;
    languageModel: LanguageModelV4;
    /** Told the usage of each summary it writes. */
    onUsage(usage: TokenUsage): void;
  };
}

/** The per-call message budget: the model's window, less what the call spends elsewhere. */
export function messageBudget(turn: Omit<TurnContext, "summarizer">): number {
  return resolveMessageBudget({
    model: turn.model,
    configMaxInputTokens: turn.maxInputTokens,
    systemPrompt: turn.system,
    tools: turn.tools,
    maxOutputTokens: turn.maxOutputTokens,
  }).budget;
}

export function contextHooks(turn: TurnContext): EngineHooks {
  const budget = messageBudget(turn);
  const provider = getProviderFromModel(turn.model);
  const { summarizer } = turn;
  return {
    transformContext: (history, opts) => {
      // A provider that rejected the last call for its size gets a halved budget per attempt.
      const attempt = opts?.overflowAttempt ?? 0;
      const callBudget = attempt > 0 ? Math.floor(budget / (1 << attempt)) : budget;
      return windowMessages(applyReasoningReplayPolicy(history, provider), callBudget);
    },
    ...(summarizer
      ? {
          rewriteHistory: buildMidTurnCompaction({
            budget,
            summarize: (folded, signal) =>
              summarizeMessages(summarizer.languageModel, folded, {
                summarizerContextTokens: getModelByString(summarizer.model)?.limits.context,
                onUsage: (usage) => summarizer.onUsage(usage),
                ...(signal ? { signal } : {}),
              }),
          }),
        }
      : {}),
  };
}
