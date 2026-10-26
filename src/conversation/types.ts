/**
 * The two conversation shapes nimblebrain-agent's compaction reads. nimblebrain-agent keeps no
 * conversation store: a host owns the conversation and hands nimblebrain-agent history
 * as model messages. These are the in-memory forms compaction folds over.
 */

import type { LanguageModelV4Message } from "@ai-sdk/provider";

type UserMessage = Extract<LanguageModelV4Message, { role: "user" }>;

/** An MCP `resource_link` a user message may carry in place of the bytes. */
export interface ResourceLinkContentPart {
  type: "resource_link";
  uri: string;
  name: string;
  mimeType?: string;
}

/** A model message, with the time it was recorded when the host knows it. */
export type StoredMessage = { timestamp?: string } & (
  | (Omit<UserMessage, "content"> & {
      content: Array<UserMessage["content"][number] | ResourceLinkContentPart>;
    })
  | Exclude<LanguageModelV4Message, { role: "user" }>
);

/** The record a compaction leaves: a summary standing in for older turns. */
export interface HistoryCompactedEvent {
  ts: string;
  type: "history.compacted";
  /** Natural-language summary of every turn before `compactedThroughTs`. */
  summary: string;
  /** Boundary: events strictly before this timestamp are summarized. */
  compactedThroughTs: string;
  /** How many messages the summary replaced (telemetry). */
  summarizedMessageCount: number;
}
