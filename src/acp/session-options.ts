/**
 * nimblebrain-agent's session options: what a client may send beyond ACP v1, and the one
 * thing nimblebrain-agent sends back.
 *
 * ACP v1 has no slot for a client's system prompt, for history the agent did
 * not produce itself, or for a turn's limits. A client that holds those (a
 * host that owns the conversation, as NimbleBrain does) sends them on
 * `session/new` under {@link SESSION_META_KEY}. Every field is optional: what a
 * client leaves out comes from nimblebrain-agent's own defaults (`nimblebrain-agent acp` reads them
 * from its environment), so a plain ACP client needs none of this.
 *
 *   _meta: { "nimblebrain-agent/session": {
 *     system?: string,           // the system prompt
 *     history?: string,          // prior messages, oldest first, encodeMessages()
 *     model?: string,            // "provider:model"
 *     maxIterations?: number, maxInputTokens?: number, maxOutputTokens?: number,
 *     thinking?: ResolvedThinking,
 *     compaction?: false | { model?: string },  // mid-turn fold: off, or its summarizer model
 *   } }
 *
 * A `session/prompt` response carries nimblebrain-agent's own stop reason under
 * {@link STOP_REASON_META_KEY}, finer than ACP's, and the turn's usage under
 * {@link USAGE_META_KEY}: every model call it made, in order, and their total.
 * ACP's own `usage` field holds the same total in ACP's coarser shape.
 */

import type { ContentBlock } from "@agentclientprotocol/sdk/unstable";
import type { LanguageModelV4Message } from "@ai-sdk/provider";
import type { ResolvedThinking, StopReason } from "../engine/types.ts";
import type { TokenUsage } from "../usage/types.ts";

/** On `session/new`: the client's options for the session. */
export const SESSION_META_KEY = "nimblebrain-agent/session";

/** On a `session/prompt` response: the engine's own stop reason. */
export const STOP_REASON_META_KEY = "nimblebrain-agent/stopReason";

/** On a `session/prompt` response: the turn's usage, per model call and in total. */
export const USAGE_META_KEY = "nimblebrain-agent/usage";

/** One model call of a turn: a loop iteration, or a summary written by a mid-turn fold. */
export interface ModelCallUsage {
  model: string;
  purpose: "turn" | "summary";
  usage: TokenUsage;
}

export interface TurnUsage {
  /** Every model call of the turn, in the order they finished. */
  calls: ModelCallUsage[];
  /** The sum of `calls`. */
  total: TokenUsage;
}

/**
 * The mid-turn fold. `false` turns it off, so a turn that outgrows its budget
 * is windowed but never summarized. An object turns it on, written by `model`
 * (the session's model when absent).
 */
export type CompactionSettings = false | { model?: string };

/** What a session runs with: the client's options over nimblebrain-agent's defaults. */
export interface SessionSettings {
  system: string;
  model: string;
  maxIterations: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  thinking?: ResolvedThinking;
  compaction?: CompactionSettings;
}

/** The options a client may send. Every field is optional. */
export type SessionOptions = Partial<SessionSettings> & {
  /** Prior history, oldest first, encoded with {@link encodeMessages}. */
  history?: string;
};

const BYTES_TAG = "__nb_agent_bytes";

/**
 * History as JSON. File parts carry their bytes as a `Uint8Array`, which JSON
 * would turn into an index-keyed object; they travel as base64 and come back
 * as bytes.
 */
export function encodeMessages(messages: LanguageModelV4Message[]): string {
  return JSON.stringify(messages, (_key, value) =>
    value instanceof Uint8Array ? { [BYTES_TAG]: Buffer.from(value).toString("base64") } : value,
  );
}

export function decodeMessages(encoded: string): LanguageModelV4Message[] {
  return JSON.parse(encoded, (_key, value) =>
    value && typeof value === "object" && typeof value[BYTES_TAG] === "string"
      ? new Uint8Array(Buffer.from(value[BYTES_TAG], "base64"))
      : value,
  ) as LanguageModelV4Message[];
}

type UserMessage = Extract<LanguageModelV4Message, { role: "user" }>;
type UserPart = UserMessage["content"][number];

/**
 * A user message as ACP prompt content. Text is text; inline image bytes are an
 * image; other inline bytes are an embedded resource. A part ACP cannot carry
 * becomes a text note naming it, so the agent knows something was attached.
 */
export function userMessageToPrompt(message: UserMessage): ContentBlock[] {
  return message.content.map((part): ContentBlock => {
    if (part.type === "text") return { type: "text", text: part.text };
    const data = part.data;
    if (data.type === "data") {
      const base64 =
        typeof data.data === "string" ? data.data : Buffer.from(data.data).toString("base64");
      if (part.mediaType.startsWith("image/")) {
        return { type: "image", data: base64, mimeType: part.mediaType };
      }
      return {
        type: "resource",
        resource: {
          uri: `attachment:${part.filename ?? "file"}`,
          blob: base64,
          mimeType: part.mediaType,
        },
      };
    }
    if (data.type === "text") return { type: "text", text: data.text };
    return { type: "text", text: `[attachment not carried over ACP: ${part.mediaType}]` };
  });
}

/** ACP prompt content as a user message: the inverse of {@link userMessageToPrompt}. */
export function promptToUserMessage(prompt: ContentBlock[]): UserMessage {
  const content = prompt.flatMap((block): UserPart[] => {
    switch (block.type) {
      case "text":
        return [{ type: "text", text: block.text }];
      case "image":
        return [
          {
            type: "file",
            mediaType: block.mimeType,
            data: { type: "data", data: new Uint8Array(Buffer.from(block.data, "base64")) },
          },
        ];
      case "resource": {
        const res = block.resource;
        if ("text" in res) return [{ type: "text", text: res.text }];
        return [
          {
            type: "file",
            mediaType: res.mimeType ?? "application/octet-stream",
            data: { type: "data", data: new Uint8Array(Buffer.from(res.blob, "base64")) },
          },
        ];
      }
      case "resource_link":
        return [{ type: "text", text: `[resource: ${block.uri}]` }];
      default:
        return [];
    }
  });
  return { role: "user", content };
}

/** The engine's stop reason, as ACP's coarser vocabulary names it. */
export function toAcpStopReason(
  stop: StopReason,
): "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" {
  switch (stop) {
    case "length":
      return "max_tokens";
    case "max_iterations":
      return "max_turn_requests";
    case "content_filter":
      return "refusal";
    case "cancelled":
      return "cancelled";
    default:
      return "end_turn";
  }
}
