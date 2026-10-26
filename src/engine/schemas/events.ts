// ---------------------------------------------------------------------------
// Engine event payloads — one named schema per event type.
//
// `EngineEventPayloads` at the bottom maps every event type to its payload, and
// `EngineEvent` (`src/engine/types.ts`) is derived from it: an emit whose `data`
// does not match its `type`'s schema fails the build, and a consumer that
// narrows on `event.type` reads a typed payload. A type means one shape; an
// event that reports something different is a different type.
//
// TypeBox, not bare interfaces, so each payload is also a JSON Schema: the
// declarative contract an event consumer outside the process can be given.
// Fields whose type is owned elsewhere (an AI SDK content block, a `ToolResult`)
// are `opaque<T>()`: the static type is exact, the JSON Schema says only what
// the field is. Nothing validates events at runtime; the engine emits from code
// we own, and the bug class is a wrong shape, which the compiler catches.
// ---------------------------------------------------------------------------

import type { LanguageModelV4Content, LanguageModelV4Message } from "@ai-sdk/provider";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import type { TokenUsage } from "../../usage/types.ts";
import type { ResourceLinkInfo } from "../content-helpers.ts";
import type { FinishReason, StopReason, ToolResult } from "../types.ts";

/**
 * A field whose type another module owns. The static type is `T`; the JSON
 * Schema records only the description, because TypeBox cannot restate `T`.
 */
function opaque<T>(description: string): TSchema & { static: T } {
  return Type.Unsafe<T>(Type.Unknown({ description }));
}

/** A key that is always present but may hold `undefined` (`{ k: x }` with `x` possibly undefined). */
function maybe<T extends TSchema>(schema: T) {
  return Type.Optional(Type.Union([schema, Type.Undefined()]));
}

// Plain `Type.Union([Type.Literal(...)])` rather than the `StringEnum`
// helper used in platform tool schemas. The platform-tool schemas need
// the legacy `{type: "string", enum: [...]}` JSON Schema form (so AJV
// and external MCP clients see the expected shape); event schemas live
// inside the process and are walked by TypeBox's `Value.Check`, which
// requires the standard `Kind` discriminator that `Type.Unsafe` (used
// in `StringEnum`) omits.

const SkillScope = Type.Union([
  Type.Literal("org"),
  Type.Literal("workspace"),
  Type.Literal("user"),
  Type.Literal("provided"),
]);
export const SkillsLoadedEntry = Type.Object({
  id: Type.String(),
  name: Type.String({ description: "The skill's own name." }),
  connector: Type.Optional(
    Type.String({ description: "MCP server that published the skill, when one did." }),
  ),
  layer: Type.Union([Type.Literal(0), Type.Literal(3), Type.Literal(4)], {
    description: "Loading mechanism's layer: 0 = always-on, 3 = tool-affinity, 4 = trigger.",
  }),
  scope: SkillScope,
  version: Type.String(),
  tokens: Type.Number(),
  contentHash: Type.String({
    description: "SHA-256 hex of the skill body composed into the prompt.",
  }),
  loadedBy: Type.Union([
    Type.Literal("always"),
    Type.Literal("tool_affinity"),
    Type.Literal("trigger"),
  ]),
  reason: Type.String(),
});
export type SkillsLoadedEntry = Static<typeof SkillsLoadedEntry>;

export const SkillsLoadedPayload = Type.Object({
  skills: Type.Array(SkillsLoadedEntry),
  totalTokens: Type.Number(),
  /** Engine-attached run id for debug/correlation. Set by engine.run(). */
  runId: Type.Optional(Type.String()),
});
export type SkillsLoadedPayload = Static<typeof SkillsLoadedPayload>;

export const ContextAssembledSource = Type.Object({
  kind: Type.String(),
  count: Type.Optional(Type.Number()),
  tokens: Type.Number(),
  toolSetHash: Type.Optional(Type.String()),
  version: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  userId: Type.Optional(Type.String()),
  messages: Type.Optional(
    Type.Number({ description: "`history`: how many messages the windowed history holds." }),
  ),
  compacted: Type.Optional(Type.Boolean()),
});
export type ContextAssembledSource = Static<typeof ContextAssembledSource>;

export const ContextAssembledPayload = Type.Object({
  sources: Type.Array(ContextAssembledSource),
  excluded: Type.Array(ContextAssembledSource),
  totalTokens: Type.Number(),
  modelMaxContext: Type.Optional(Type.Number()),
  headroomTokens: Type.Optional(Type.Number()),
  /** Engine-attached run id for debug/correlation. */
  runId: Type.Optional(Type.String()),
});
export type ContextAssembledPayload = Static<typeof ContextAssembledPayload>;

/**
 * An app server's notification, relayed to that server's views. `server` is the
 * bare server name (an iframe's `data-app`), `method` one of
 * `RELAYED_SERVER_NOTIFICATIONS`, `params` what the SDK parsed, size-capped.
 *
 * It names exactly one owner: `workspaceId` for a workspace's source, or
 * `userId` for a person's own app, which belongs to no workspace.
 */
export const ToolPromotionChangedPayload = Type.Object({
  runId: Type.String(),
  toolName: Type.String(),
  /**
   * Why the change happened. Absent for normal agent-driven add/remove.
   * Present (`"evicted"`) when the engine reclaimed a slot under the
   * `maxActiveTools` cap.
   */
  reason: Type.Optional(Type.String()),
});
export type ToolPromotionChangedPayload = Static<typeof ToolPromotionChangedPayload>;

/**
 * `connector.skill.injected` — a curated connector overlay surfaced into
 * the conversation history for the first time, triggered by a matching
 * connector tool call. The reconstructor turns this into a synthetic
 * message; the body is wrapped in `<connector-skill>` containment at that point.
 */
export const ConnectorSkillInjectedPayload = Type.Object({
  /** Engine-attached run id for debug/correlation. */
  runId: Type.String(),
  /** The connector tool call that triggered the surfacing (e.g. `gmail__send`). */
  toolName: Type.String(),
  /** The overlay's skill name (matches the materialized manifest `name`). */
  skillName: Type.String(),
  /** The overlay body (markdown), surfaced verbatim into history. */
  skillBody: Type.String(),
  /** Storage tier, or `connector` for a curated overlay. */
  scope: Type.String(),
  /**
   * The call held until this body arrived. Absent when the body followed a
   * call that ran, or a promotion.
   */
  heldToolCallId: Type.Optional(Type.String()),
});
export type ConnectorSkillInjectedPayload = Static<typeof ConnectorSkillInjectedPayload>;

/**
 * `skill.not_delivered` — a skill bound to a called tool did not reach the
 * model on that call: its body could not be fetched, one delivery's size limit
 * left it out, or a `beforeToolCall` hook renamed the call past the hold. Recorded
 * so the load ledger shows the gap instead of silence.
 */
export const SkillNotDeliveredPayload = Type.Object({
  runId: Type.String(),
  toolName: Type.String(),
  skillName: Type.String(),
  reason: Type.Union([
    Type.Literal("fetch_failed"),
    Type.Literal("capped"),
    Type.Literal("renamed_unheld"),
  ]),
});
export type SkillNotDeliveredPayload = Static<typeof SkillNotDeliveredPayload>;

/** A chat turn's conversation is resolved and the run is about to start. */
/** The engine is starting a run: its configuration and the prompt it assembled. */
export const RunStartPayload = Type.Object({
  runId: Type.String(),
  model: Type.String(),
  maxIterations: Type.Number(),
  maxOutputTokens: Type.Number(),
  maxInputTokens: Type.Number(),
  toolCount: Type.Number(),
  toolNames: Type.Array(Type.String()),
  systemPromptLength: Type.Number(),
  systemPrompt: Type.String(),
  messageCount: Type.Number(),
  messageRoles: opaque<LanguageModelV4Message["role"][]>("The role of each message sent."),
  estimatedMessageTokens: Type.Number(),
});
export type RunStartPayload = Static<typeof RunStartPayload>;

/** A run finished, completed or cancelled. */
export const RunDonePayload = Type.Object({
  runId: Type.String(),
  stopReason: opaque<StopReason>("Why the loop stopped (`StopReason`)."),
  iterations: Type.Number(),
  totalMs: Type.Number(),
});
export type RunDonePayload = Static<typeof RunDonePayload>;

/**
 * The agent runtime a run executes on, and that runtime's own session for it.
 * A conversation's runs may each execute on a different runtime; this is the
 * map from a run to where it ran.
 */
/** A run failed. */
export const RunErrorPayload = Type.Object({
  runId: Type.String(),
  error: Type.String({ description: "The error's message." }),
  type: Type.String({ description: "The error's class name." }),
});
export type RunErrorPayload = Static<typeof RunErrorPayload>;

/** A piece of streamed model text (`text.delta`) or reasoning (`reasoning.delta`). */
export const TextDeltaPayload = Type.Object({
  runId: Type.String(),
  text: Type.String(),
});
export type TextDeltaPayload = Static<typeof TextDeltaPayload>;

/** The model began streaming a tool call's arguments. */
export const ToolPreparingPayload = Type.Object({
  runId: Type.String(),
  id: Type.String({ description: "The tool call id." }),
  name: Type.String(),
});
export type ToolPreparingPayload = Static<typeof ToolPreparingPayload>;

/** The model finished streaming a tool call's arguments. */
export const ToolPreparingDonePayload = Type.Object({
  runId: Type.String(),
  id: Type.String({ description: "The tool call id." }),
});
export type ToolPreparingDonePayload = Static<typeof ToolPreparingDonePayload>;

/** A tool call is about to execute, with the input as the model sent it (before coercion). */
export const ToolStartPayload = Type.Object({
  runId: Type.String(),
  name: Type.String(),
  id: Type.String(),
  resourceUri: maybe(Type.String({ description: "The tool's inline `ui://` binding." })),
  input: Type.Record(Type.String(), Type.Unknown()),
});
export type ToolStartPayload = Static<typeof ToolStartPayload>;

/** A tool call finished. */
export const ToolDonePayload = Type.Object({
  runId: Type.String(),
  name: Type.String(),
  id: Type.String(),
  ok: Type.Boolean(),
  ms: Type.Number(),
  resourceUri: maybe(Type.String({ description: "The tool's inline `ui://` binding." })),
  output: Type.String({ description: "The full output text, audience-filtered." }),
  result: maybe(opaque<ToolResult>("The raw result, when the tool has an inline UI binding.")),
  modelOutput: Type.Optional(
    Type.String({ description: "The bounded text the model saw, when it differs from `output`." }),
  ),
  resourceLinks: Type.Optional(opaque<ResourceLinkInfo[]>("MCP `resource_link` blocks.")),
  supervisorTripped: Type.Optional(Type.Literal(true)),
  trippedTool: Type.Optional(Type.String()),
  held: Type.Optional(
    Type.Literal(true, {
      description: "The call did not run; it waits for guidance the model has not read yet.",
    }),
  ),
  consecutiveRepeats: Type.Optional(Type.Number()),
  workspaceId: Type.Optional(
    Type.String({ description: "The workspace the call ran in, stamped by the runtime." }),
  ),
});
export type ToolDonePayload = Static<typeof ToolDonePayload>;

/** A running tool call reported progress. */
export const ToolProgressPayload = Type.Object({
  runId: Type.String(),
  id: Type.String({ description: "The tool call id." }),
  message: Type.String(),
  workspaceId: Type.Optional(
    Type.String({ description: "The workspace the call ran in, stamped by the runtime." }),
  ),
});
export type ToolProgressPayload = Static<typeof ToolProgressPayload>;

/** A task-augmented MCP tool call changed status: created, working, done, or cancelled. */
/** A provider call completed. */
export const LlmDonePayload = Type.Object({
  runId: Type.String(),
  model: Type.String(),
  content: opaque<LanguageModelV4Content[]>("AI SDK V4 content blocks."),
  usage: opaque<TokenUsage>("Token usage for this call (`TokenUsage`)."),
  llmMs: Type.Number(),
  ttftMs: maybe(Type.Number({ description: "Time to first token; absent with no output part." })),
  estimatedInputTokens: Type.Number(),
  finishReason: opaque<FinishReason>("AI SDK unified finish reason."),
  finishReasonRaw: Type.Optional(Type.String({ description: "The provider's own stop reason." })),
});
export type LlmDonePayload = Static<typeof LlmDonePayload>;

/** A provider call failed terminally (retries exhausted). Not emitted for a cancellation. */
export const LlmErrorPayload = Type.Object({
  runId: Type.String(),
  model: Type.String(),
});
export type LlmErrorPayload = Static<typeof LlmErrorPayload>;

/** A call was rejected for exceeding the context window; history is re-windowed and retried. */
export const ContextOverflowRecoveryPayload = Type.Object({
  runId: Type.String(),
  attempt: Type.Number(),
  previousMessageCount: Type.Number(),
  errorMessage: Type.String(),
});
export type ContextOverflowRecoveryPayload = Static<typeof ContextOverflowRecoveryPayload>;

/** A catalog skill's body reached the model through `nb__use_skill`. */
export const SkillActivatedPayload = Type.Object({
  runId: Type.String(),
  toolCallId: Type.String(),
  skillName: Type.String(),
  scope: Type.String(),
  tokens: Type.Number(),
});
export type SkillActivatedPayload = Static<typeof SkillActivatedPayload>;

/** A skill's surfacing was suppressed or restored for the conversation. */
export const SkillSuppressionPayload = Type.Object({
  runId: Type.String(),
  skillName: Type.String(),
  suppressed: Type.Boolean(),
});
export type SkillSuppressionPayload = Static<typeof SkillSuppressionPayload>;

/** A connector was installed in a workspace. */
/** A connector was removed from a workspace. */
/**
 * A remote connector's connection changed state for one principal:
 * `_workspace` for a workspace-scoped connector, else a member's id.
 */
/**
 * A connector source's liveness changed. `source.*` comes from the source
 * itself (its process crashed, or restarted); `connector.*` from the health
 * monitor's sweep (found down, backing off, restarting, recovered).
 */
/** A conversation got its title. Names the owner, not a workspace. */
/** Configuration or preferences changed; `fields` names what. */
/** An iframe app called a tool through the bridge. */
/** A bridge tool call finished. */
/** A notification route target delivered. */
/** A notification route target reached a terminal outcome other than delivery. */
/** A request ended in an unhandled server error. */
/** A request failed authentication. */
/** A privileged tool action was refused. */
/** A stored secret was revealed to a caller. Never the value. */
/** A stored secret claimed to be sealed and could not be opened. Never the value. */
/** The credential store finished its boot reconcile. */
/**
 * Every engine event type and its payload. `EngineEventType` and `EngineEvent`
 * (`src/engine/types.ts`) are derived from this map, so adding an event is one
 * entry here.
 */


export interface EngineEventPayloads {
  "run.start": RunStartPayload;
  "run.done": RunDonePayload;
  "run.error": RunErrorPayload;
  "text.delta": TextDeltaPayload;
  "reasoning.delta": TextDeltaPayload;
  "tool.preparing": ToolPreparingPayload;
  "tool.preparing.done": ToolPreparingDonePayload;
  "tool.start": ToolStartPayload;
  "tool.done": ToolDonePayload;
  "tool.progress": ToolProgressPayload;
  "tool.promoted": ToolPromotionChangedPayload;
  "tool.released": ToolPromotionChangedPayload;
  "llm.done": LlmDonePayload;
  /**
   * A provider LLM call failed terminally — the call threw and the in-call
   * retry was exhausted (or a context overflow could not be recovered).
   * NOT emitted for user-initiated cancellations (abort). Payload: { runId,
   * model }. Observe-only signal for the LLM error-rate metric; the error
   * itself still propagates and ends the run as `run.error`.
   */
  "llm.error": LlmErrorPayload;
  "skills.loaded": SkillsLoadedPayload & { runId: string };
  /**
   * A curated connector-skill overlay was surfaced into the conversation for
   * the first time, triggered by a matching connector tool call. The
   * reconstructor turns this into a synthetic message carrying the skill
   * body, placed after the tool results of the iteration that triggered it, so
   * the guidance rides the cached, append-only history and is in context for
   * the model's next action instead of re-entering the system prefix. Emitted
   * at most once per (conversation, skill). Payload: { runId, toolName,
   * skillName, skillBody, scope }.
   */
  "connector.skill.injected": ConnectorSkillInjectedPayload;
  /**
   * A catalog skill's full body was delivered to the model via the
   * `nb__use_skill` activation tool. The body itself persists as the tool
   * result (`tool.done`), so — unlike `connector.skill.injected` — the
   * reconstructor synthesizes NO extra message for this event; it only stamps
   * the dedup marker on the reconstructed tool result. Emitted at most once
   * per (conversation, skill). Payload: { runId, toolCallId, skillName,
   * scope, tokens }.
   */
  "skill.activated": SkillActivatedPayload;
  "skill.not_delivered": SkillNotDeliveredPayload;
  "skill.suppression": SkillSuppressionPayload;
  "context.assembled": ContextAssembledPayload & { runId: string };
  /**
   * Emitted when a model call is rejected for exceeding the context window
   * and the engine re-windows history with a tighter budget before retrying.
   * Payload: { runId, attempt, previousMessageCount, errorMessage }.
   */
  "context.overflow_recovery": ContextOverflowRecoveryPayload;
}
