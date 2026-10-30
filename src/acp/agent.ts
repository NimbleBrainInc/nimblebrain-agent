/**
 * nimblebrain-agent's ACP agent: the engine loop, served over the Agent Client
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
import type { LanguageModelV4, LanguageModelV4Message } from "@ai-sdk/provider";
import { contextHooks, type TurnContext } from "../context/hooks.ts";
import { AgentEngine } from "../engine/engine.ts";
import type { EngineConfig, EngineEvent, EventSink } from "../engine/types.ts";
import type { ModelAccess, ModelResolver } from "../model/resolve.ts";
import { log } from "../observability/log.ts";
import { addUsage, type TokenUsage } from "../usage/types.ts";
import { acpMcpTransport } from "./acp-mcp-transport.ts";
import {
  connectMcpToolRouter,
  httpMcpServer,
  type McpToolRouter,
  type ReachableMcpServer,
} from "./mcp-tool-router.ts";
import {
  disableProvider,
  listProviders,
  type ProviderRoutes,
  sessionRoutes,
  setProvider,
} from "./providers.ts";
import {
  decodeMessages,
  type ModelCallUsage,
  promptToUserMessage,
  REPLACED_OPTIONS,
  SESSION_META_KEY,
  type SessionOptions,
  type SessionSettings,
  STOP_REASON_META_KEY,
  type TurnUsage,
  toAcpStopReason,
  USAGE_META_KEY,
} from "./session-options.ts";

export const AGENT_VERSION = "0.5.0";

interface AgentSession {
  settings: SessionSettings;
  router: McpToolRouter;
  /** Everything the session has said and done, oldest first. */
  history: LanguageModelV4Message[];
  /** The session's own model access; absent, the worker's key and endpoint. */
  access?: ModelAccess;
  turn?: AbortController;
}

export interface AgentOptions {
  resolveModel: ModelResolver;
  /** What a session runs with where the client's options say nothing. */
  defaults: SessionSettings;
  /**
   * The serving process's say in a session's life: whether a new session may
   * open (not while the process drains), and each turn's start and end, so it
   * can wait for the turns in flight before it stops.
   */
  lifecycle?: AgentLifecycle;
  /** The process's environment, which `providers/list` reports the default routes from. */
  env?: Record<string, string | undefined>;
}

export interface AgentLifecycle {
  admit(): boolean;
  turnStarted(): void;
  turnEnded(): void;
}

export function createAgent(opts: AgentOptions): acp.AgentApp {
  const sessions = new Map<string, AgentSession>();
  // One agent per connection, so this is the connection's own provider configuration.
  const routes: ProviderRoutes = new Map();
  const env = opts.env ?? process.env;

  return acp
    .agent({ name: "nimblebrain-agent" })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, acp: true },
        sessionCapabilities: { systemPrompt: { mode: { override: {} } } },
        providers: {},
      },
      agentInfo: { name: "nimblebrain-agent", version: AGENT_VERSION },
    }))
    .onRequest(acp.methods.agent.providers.list, () => listProviders(routes, env))
    .onRequest(acp.methods.agent.providers.set, (ctx) => {
      setProvider(routes, ctx.params);
      return {};
    })
    .onRequest(acp.methods.agent.providers.disable, (ctx) => {
      disableProvider(routes, ctx.params);
      return {};
    })
    .onRequest(acp.methods.agent.session.new, async (ctx) => {
      const sent = (ctx.params._meta?.[SESSION_META_KEY] ?? {}) as SessionOptions;
      if (opts.lifecycle && !opts.lifecycle.admit()) {
        throw acp.RequestError.internalError(undefined, "the agent is draining");
      }
      refuseReplacedOptions(sent);
      const { history, ...overrides } = sent;
      const access = sessionAccess(routes);
      const settings: SessionSettings = { ...opts.defaults, ...overrides };
      const system = systemOf(ctx.params.systemPrompt, opts.defaults.system);
      if (system !== undefined) settings.system = system;
      const router = await connectMcpToolRouter(
        ctx.params.mcpServers.map((server) => reachable(server, ctx.client)),
      );
      const sessionId = crypto.randomUUID();
      const prior = history ? decodeMessages(history) : [];
      logSessionOpened(sessionId, settings, {
        mcpServers: ctx.params.mcpServers.length,
        historyMessages: prior.length,
        modelEndpoint: endpointOf(access, providerOf(settings.model)),
      });
      sessions.set(sessionId, {
        settings,
        router,
        history: prior,
        ...(access ? { access } : {}),
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
      const calls: ModelCallUsage[] = [];
      const sink: EventSink = {
        emit(event) {
          updates.forward(event);
          recordHistory(session.history, event);
          if (event.type === "llm.done") {
            calls.push({ model: event.data.model, purpose: "turn", usage: event.data.usage });
          }
        },
      };
      const { settings } = session;
      const tools = await session.router.availableTools();
      const resolve = (model: string) => opts.resolveModel(model, session.access);
      const languageModel = resolve(settings.model);
      const config: EngineConfig = {
        ...engineConfigOf(settings, turn.signal),
        hooks: contextHooks({
          model: settings.model,
          system: settings.system,
          tools,
          maxInputTokens: settings.maxInputTokens,
          maxOutputTokens: settings.maxOutputTokens,
          summarizer: summarizerOf(settings, languageModel, resolve, (model, usage) =>
            calls.push({ model, purpose: "summary", usage }),
          ),
        }),
      };
      const engine = new AgentEngine(languageModel, session.router, sink);
      const started = performance.now();
      const turnFields = () => ({
        session_id: ctx.params.sessionId,
        model_calls: calls.length,
        duration_ms: Math.round(performance.now() - started),
      });
      opts.lifecycle?.turnStarted();
      try {
        const result = await engine.run(config, settings.system, [...session.history], tools);
        await updates.drained();
        const usage = turnUsage(calls);
        log.info("[acp] turn ended", {
          ...turnFields(),
          stop_reason: result.stopReason,
          input_tokens: usage.total.inputTokens,
          output_tokens: usage.total.outputTokens,
        });
        return {
          stopReason: toAcpStopReason(result.stopReason),
          usage: acpUsage(usage.total),
          _meta: { [STOP_REASON_META_KEY]: result.stopReason, [USAGE_META_KEY]: usage },
        };
      } catch (err) {
        await updates.drained();
        if (turn.signal.aborted) {
          log.info("[acp] turn ended", { ...turnFields(), stop_reason: "cancelled" });
          return { stopReason: "cancelled" as const };
        }
        log.warn("[acp] turn failed", { ...turnFields(), ...failureOf(err) });
        throw err;
      } finally {
        if (session.turn === turn) session.turn = undefined;
        opts.lifecycle?.turnEnded();
      }
    })
    .onNotification(acp.methods.agent.session.cancel, (ctx) => {
      sessions.get(ctx.params.sessionId)?.turn?.abort();
    })
    .onRequest(acp.methods.agent.session.close, async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      sessions.delete(ctx.params.sessionId);
      if (session) log.info("[acp] session closed", { session_id: ctx.params.sessionId });
      session?.turn?.abort();
      await session?.router.close();
      return {};
    })
    .onConnect((connection) => {
      void connection.closed.then(async () => {
        if (sessions.size > 0) {
          log.info("[acp] connection closed", { open_sessions: [...sessions.keys()] });
        }
        for (const session of sessions.values()) {
          session.turn?.abort();
          await session.router.close();
        }
        sessions.clear();
      });
    });
}

/**
 * The line a new session logs. The session id is what a client records for the
 * session (a host keeps it per run), so it joins this worker's lines to the
 * client's run. The credential is never logged; the host the session model's
 * calls go to is.
 */
function logSessionOpened(
  sessionId: string,
  settings: SessionSettings,
  opened: { mcpServers: number; historyMessages: number; modelEndpoint?: string },
): void {
  log.info("[acp] session opened", {
    session_id: sessionId,
    model: settings.model,
    mcp_servers: opened.mcpServers,
    history_messages: opened.historyMessages,
    ...(opened.modelEndpoint ? { model_endpoint_host: hostOf(opened.modelEndpoint) } : {}),
  });
}

/**
 * What a failed turn logs of its error: the error's class and, when it carries one, its HTTP
 * status. Never the message: a provider's error text can echo the request's credential.
 */
function failureOf(err: unknown): { error: string; status?: number } {
  const { status, statusCode } = (err ?? {}) as { status?: unknown; statusCode?: unknown };
  const code = typeof status === "number" ? status : statusCode;
  return {
    error: err instanceof Error ? err.name : typeof err,
    ...(typeof code === "number" ? { status: code } : {}),
  };
}

/** The session's own access to its models: the connection's provider routes as they stand now. */
function sessionAccess(routes: ProviderRoutes): ModelAccess | undefined {
  const providers = sessionRoutes(routes);
  return providers ? { providers } : undefined;
}

/** Refuse an option ACP's own fields replaced, naming the field to use. */
function refuseReplacedOptions(sent: Record<string, unknown>): void {
  for (const [option, use] of Object.entries(REPLACED_OPTIONS)) {
    if (option in sent) {
      throw acp.RequestError.invalidParams(
        undefined,
        `the session option "${option}" is gone: use ${use}`,
      );
    }
  }
}

/**
 * The session's system prompt from ACP's `systemPrompt`, or `undefined` when the
 * client sent none. `override` replaces nimblebrain-agent's own prompt; `append`
 * adds to it. Only text is taken, and any other mode is refused, as the spec asks.
 */
function systemOf(sent: acp.SystemPrompt | null | undefined, own: string): string | undefined {
  if (!sent) return undefined;
  const parts = sent.content.map((block) => {
    if (block.type !== "text") {
      throw acp.RequestError.invalidParams(undefined, "systemPrompt takes text content only");
    }
    return block.text;
  });
  const text = parts.join("\n\n");
  if (sent.mode === "override") return text;
  if (sent.mode === "append") return own ? `${own}\n\n${text}` : text;
  throw acp.RequestError.invalidParams(
    undefined,
    `systemPrompt mode "${sent.mode}" is not supported`,
  );
}

/** Where a session's calls for one provider go, when the session says. */
function endpointOf(access: ModelAccess | undefined, provider: string): string | undefined {
  return access?.providers?.[provider]?.baseUrl;
}

/** The provider half of a `provider:model` string, empty when it names none. */
function providerOf(model: string): string {
  const separator = model.indexOf(":");
  return separator < 0 ? "" : model.slice(0, separator);
}

/** A URL's host for a log line, never its path or query. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(unparsed)";
  }
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

/** Who writes the session's mid-turn folds, or nobody when it turned them off. */
function summarizerOf(
  settings: SessionSettings,
  languageModel: LanguageModelV4,
  resolveModel: (model: string) => LanguageModelV4,
  onUsage: (model: string, usage: TokenUsage) => void,
): TurnContext["summarizer"] {
  if (settings.compaction === false) return undefined;
  const model = settings.compaction?.model ?? settings.model;
  return {
    model,
    languageModel: model === settings.model ? languageModel : resolveModel(model),
    onUsage: (usage) => onUsage(model, usage),
  };
}

function turnUsage(calls: ModelCallUsage[]): TurnUsage {
  const total = { inputTokens: 0, outputTokens: 0 };
  for (const call of calls) addUsage(total, call.usage);
  return { calls, total };
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

/** How to reach one MCP server the client named: over HTTP, or over this connection (`acp`). */
function reachable(server: acp.McpServer, client: acp.AgentContext): ReachableMcpServer {
  if ("type" in server && server.type === "http") return httpMcpServer(server);
  if ("type" in server && server.type === "acp") {
    const { serverId } = server;
    return { name: server.name, transport: () => acpMcpTransport(client, serverId) };
  }
  throw acp.RequestError.invalidParams(
    undefined,
    `MCP server ${server.name}: only http and acp are supported`,
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
