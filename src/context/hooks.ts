/**
 * nimblebrain-agent's context management for one turn: what keeps the working history
 * inside the model's window while the loop runs.
 *
 * The same two mechanisms NimbleBrain's native engine runs, wired the same
 * way: windowing on every model call (`transformContext`, with the provider's
 * reasoning replay policy), and a mid-turn fold that summarizes older history
 * when the turn outgrows its budget (`rewriteHistory`). The summary is written
 * by the session's own model; its usage is added to the turn's.
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
  languageModel: LanguageModelV4;
  system: string;
  tools: ToolSchema[];
  maxInputTokens: number;
  maxOutputTokens: number;
  /** Told the usage of each summary a fold writes. */
  onSummaryUsage(usage: TokenUsage): void;
}

/** The per-call message budget: the model's window, less what the call spends elsewhere. */
export function messageBudget(turn: Omit<TurnContext, "languageModel" | "onSummaryUsage">): number {
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
  return {
    transformContext: (history, opts) => {
      // A provider that rejected the last call for its size gets a halved budget per attempt.
      const attempt = opts?.overflowAttempt ?? 0;
      const callBudget = attempt > 0 ? Math.floor(budget / (1 << attempt)) : budget;
      return windowMessages(applyReasoningReplayPolicy(history, provider), callBudget);
    },
    rewriteHistory: buildMidTurnCompaction({
      budget,
      summarize: (folded, signal) =>
        summarizeMessages(turn.languageModel, folded, {
          summarizerContextTokens: getModelByString(turn.model)?.limits.context,
          onUsage: (usage) => turn.onSummaryUsage(usage),
          ...(signal ? { signal } : {}),
        }),
    }),
  };
}
