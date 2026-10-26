/**
 * nimblebrain-agent's ACP agent: NimbleBrain's engine loop, served over the Agent Client
 * Protocol to any client.
 *
 * Inside nimblebrain-agent: model inference, the loop, tool calls to the MCP servers the
 * client names at `session/new`, context management (windowing and mid-turn
 * compaction), streaming, and cancellation. Outside it, with the client: the
 * conversation's record, which tools exist and who may call them, credentials,
 * and anything that must outlive the session.
 *
 * A session runs on nimblebrain-agent's defaults, with the client's session options over
 * them (`./session-options.ts`). A plain ACP client sends none and gets a
 * working agent; a host that owns the conversation sends its system prompt,
 * history and limits.
 */

import * as acp from "@agentclientprotocol/sdk/unstable";
import type { LanguageModelV4Message } from "@ai-sdk/provider";
import { contextHooks } from "../context/hooks.ts";
import { AgentEngine } from "../engine/engine.ts";
import type { EngineConfig, EngineEvent, EventSink } from "../engine/types.ts";
import type { ModelResolver } from "../model/resolve.ts";
import { log } from "../observability/log.ts";
import { addUsage, type TokenUsage } from "../usage/types.ts";
import { connectMcpToolRouter, type HttpMcpServer, type McpToolRouter } from "./mcp-tool-router.ts";
import {
  decodeMessages,
  promptToUserMessage,
  SESSION_META_KEY,
  type SessionOptions,
  type SessionSettings,
  STOP_REASON_META_KEY,
  toAcpStopReason,
} from "./session-options.ts";

export const AGENT_VERSION = "0.1.0";

interface AgentSession {
  settings: SessionSettings;
  router: McpToolRouter;
  /** Everything the session has said and done, oldest first. */
  history: LanguageModelV4Message[];
  turn?: AbortController;
}

export interface AgentOptions {
  resolveModel: ModelResolver;
  /** What a session runs with where the client's options say nothing. */
  defaults: SessionSettings;
}

export function createAgent(opts: AgentOptions): acp.AgentApp {
  const sessions = new Map<string, AgentSession>();

  return acp
    .agent({ name: "nimblebrain-agent" })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true },
      },
      agentInfo: { name: "nimblebrain-agent", version: AGENT_VERSION },
    }))
    .onRequest(acp.methods.agent.session.new, async (ctx) => {
      const sent = (ctx.params._meta?.[SESSION_META_KEY] ?? {}) as SessionOptions;
      const { history, ...overrides } = sent;
      const settings: SessionSettings = { ...opts.defaults, ...overrides };
      const router = await connectMcpToolRouter(ctx.params.mcpServers.map(httpServer));
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, {
        settings,
        router,
        history: history ? decodeMessages(history) : [],
      });
      return { sessionId };
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (!session) throw acp.RequestError.invalidParams(undefined, "unknown session");
      session.turn?.abort();
      const turn = new AbortController();
      session.turn = turn;
      session.history.push(promptToUserMessage(ctx.params.prompt));

      const updates = createUpdateStream(ctx.client, ctx.params.sessionId);
      const sink: EventSink = {
        emit(event) {
          updates.forward(event);
          recordHistory(session.history, event);
        },
      };
      const { settings } = session;
      const tools = await session.router.availableTools();
      const languageModel = opts.resolveModel(settings.model);
      // A fold's summary is part of what the turn spent.
      const summaryUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      const config: EngineConfig = {
        ...engineConfigOf(settings, turn.signal),
        hooks: contextHooks({
          model: settings.model,
          languageModel,
          system: settings.system,
          tools,
          maxInputTokens: settings.maxInputTokens,
          maxOutputTokens: settings.maxOutputTokens,
          onSummaryUsage: (usage) => addUsage(summaryUsage, usage),
        }),
      };
      const engine = new AgentEngine(languageModel, session.router, sink);
      try {
        const result = await engine.run(config, settings.system, [...session.history], tools);
        await updates.drained();
        const usage = { ...result.usage };
        addUsage(usage, summaryUsage);
        return {
          stopReason: toAcpStopReason(result.stopReason),
          usage: acpUsage(usage),
          _meta: { [STOP_REASON_META_KEY]: result.stopReason },
        };
      } catch (err) {
        await updates.drained();
        if (turn.signal.aborted) return { stopReason: "cancelled" as const };
        throw err;
      } finally {
        if (session.turn === turn) session.turn = undefined;
      }
    })
    .onNotification(acp.methods.agent.session.cancel, (ctx) => {
      sessions.get(ctx.params.sessionId)?.turn?.abort();
    })
    .onRequest(acp.methods.agent.session.close, async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      sessions.delete(ctx.params.sessionId);
      session?.turn?.abort();
      await session?.router.close();
      return {};
    })
    .onConnect((connection) => {
      void connection.closed.then(async () => {
        for (const session of sessions.values()) {
          session.turn?.abort();
          await session.router.close();
        }
        sessions.clear();
      });
    });
}

function engineConfigOf(settings: SessionSettings, signal: AbortSignal): EngineConfig {
  return {
    model: settings.model,
    maxIterations: settings.maxIterations,
    maxInputTokens: settings.maxInputTokens,
    maxOutputTokens: settings.maxOutputTokens,
    ...(settings.thinking ? { thinking: settings.thinking } : {}),
    signal,
  };
}

/** The run's usage in ACP's (unstable) turn-usage shape. */
function acpUsage(usage: TokenUsage): acp.Usage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
    ...(usage.cacheReadTokens ? { cachedReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens ? { cachedWriteTokens: usage.cacheWriteTokens } : {}),
    ...(usage.reasoningTokens ? { thoughtTokens: usage.reasoningTokens } : {}),
  };
}

function httpServer(server: acp.McpServer): HttpMcpServer {
  if ("type" in server && server.type === "http") {
    return { name: server.name, url: server.url, headers: server.headers };
  }
  throw acp.RequestError.invalidParams(
    undefined,
    `MCP server ${server.name}: only http is supported`,
  );
}

/**
 * Engine events as ACP session updates, sent in the order the engine emitted
 * them. `drained` resolves once every update has been written, so a prompt
 * response never overtakes the updates of its own turn.
 */
function createUpdateStream(client: acp.AgentContext, sessionId: string) {
  let chain: Promise<void> = Promise.resolve();
  const send = (update: acp.SessionUpdate) => {
    chain = chain
      .then(() => client.notify(acp.methods.client.session.update, { sessionId, update }))
      .catch((err) => log.warn(`[nimblebrain-agent] session update not delivered: ${String(err)}`));
  };
  return {
    forward(event: EngineEvent) {
      switch (event.type) {
        case "text.delta":
          send({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: event.data.text },
          });
          return;
        case "reasoning.delta":
          send({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: event.data.text },
          });
          return;
        case "tool.start":
          send({
            sessionUpdate: "tool_call",
            toolCallId: event.data.id,
            title: event.data.name,
            kind: "other",
            status: "in_progress",
            rawInput: event.data.input,
          });
          return;
        case "tool.done":
          send({
            sessionUpdate: "tool_call_update",
            toolCallId: event.data.id,
            status: event.data.ok ? "completed" : "failed",
            content: [{ type: "content", content: { type: "text", text: event.data.output } }],
          });
          return;
        default:
          return;
      }
    },
    drained: () => chain,
  };
}

/**
 * Keep the session's history as the engine would replay it: each model call's
 * content, then its tool results in one tool message, so a second prompt in
 * the same session sees what the first did.
 */
function recordHistory(history: LanguageModelV4Message[], event: EngineEvent): void {
  if (event.type === "llm.done") {
    const content = event.data.content.filter(
      (b) => b.type === "text" || b.type === "tool-call" || b.type === "reasoning",
    );
    if (content.length > 0) {
      history.push({
        role: "assistant",
        content: content.map((b) =>
          b.type === "tool-call"
            ? {
                type: "tool-call" as const,
                toolCallId: b.toolCallId,
                toolName: b.toolName,
                input: JSON.parse(b.input || "{}"),
              }
            : b.type === "text"
              ? { type: "text" as const, text: b.text }
              : { type: "reasoning" as const, text: b.text },
        ),
      });
    }
    return;
  }
  if (event.type === "tool.done") {
    const part = {
      type: "tool-result" as const,
      toolCallId: event.data.id,
      toolName: event.data.name,
      output: { type: "text" as const, value: event.data.modelOutput ?? event.data.output },
    };
    const last = history.at(-1);
    if (last?.role === "tool") last.content.push(part);
    else history.push({ role: "tool", content: [part] });
  }
}
