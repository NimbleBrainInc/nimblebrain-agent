import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk/unstable";
import type {
  LanguageModelV4,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { createAgent } from "../../src/acp/agent.ts";
import {
  encodeMessages,
  MODEL_ERROR_KEY,
  SESSION_META_KEY,
  type SessionSettings,
  STOP_REASON_META_KEY,
  type TurnUsage,
  USAGE_META_KEY,
} from "../../src/acp/session-options.ts";
import type { ModelAccess, ModelResolver } from "../../src/model/resolve.ts";
import { log } from "../../src/observability/log.ts";
import { type AcpStubMcp, acpStubMcp } from "../helpers/acp-stub-mcp.ts";
import { createEchoModel, type EchoModelResponse } from "../helpers/echo-model.ts";
import { type StubMcp, startStubMcp } from "../helpers/stub-mcp.ts";

// nimblebrain-agent as any ACP client sees it: a session, tools from the MCP servers the
// client names, streamed updates, and a stop reason. No host, no platform.

const DEFAULTS: SessionSettings = {
  model: "anthropic:claude-sonnet-4-6",
  system: "default system prompt",
  maxIterations: 5,
  maxInputTokens: 100_000,
  maxOutputTokens: 1_000,
};

let mcp: StubMcp | undefined;
afterEach(async () => {
  await mcp?.close();
  mcp = undefined;
});

/**
 * A model that records every prompt it is sent, answering from a script. When `usage` is
 * given, each call reports the next entry as the provider's usage, in call order.
 */
function recording(
  script: EchoModelResponse[],
  usage: LanguageModelV4Usage[] = [],
): {
  model: LanguageModelV4;
  prompts: LanguageModelV4Prompt[];
} {
  const prompts: LanguageModelV4Prompt[] = [];
  const echo = createEchoModel({ responses: script });
  const reported = [...usage];
  return {
    prompts,
    model: {
      ...echo,
      async doStream(options) {
        prompts.push(options.prompt);
        const result = await echo.doStream(options);
        const next = reported.shift();
        if (!next) return result;
        const stream = result.stream.pipeThrough(
          new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
            transform(part, controller) {
              controller.enqueue(part.type === "finish" ? { ...part, usage: next } : part);
            },
          }),
        );
        return { ...result, stream };
      },
      async doGenerate(options) {
        prompts.push(options.prompt);
        const result = await echo.doGenerate(options);
        const next = reported.shift();
        return next ? { ...result, usage: next } : result;
      },
    },
  };
}

/** A provider usage report, with Anthropic's cache-write TTL split under `raw` when given. */
function providerUsage(u: {
  noCache: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  output: number;
}): LanguageModelV4Usage {
  return {
    inputTokens: {
      total: u.noCache + u.cacheRead + u.cacheWrite,
      noCache: u.noCache,
      cacheRead: u.cacheRead,
      cacheWrite: u.cacheWrite,
    },
    outputTokens: { total: u.output, text: u.output, reasoning: undefined },
    ...(u.cacheWrite1h != null
      ? { raw: { cache_creation: { ephemeral_1h_input_tokens: u.cacheWrite1h } } }
      : {}),
  };
}

async function session(
  model: LanguageModelV4 | ModelResolver,
  meta?: Record<string, unknown>,
  onUpdate?: (u: acp.SessionUpdate) => void,
  overAcp?: AcpStubMcp,
  standard: { routes?: acp.SetProviderRequest[]; systemPrompt?: acp.SystemPrompt } = {},
) {
  const resolveModel = typeof model === "function" ? model : () => model;
  if (!overAcp) mcp ??= startStubMcp((input) => `order ${input.orderId} shipped`);
  const updates: acp.SessionUpdate[] = [];
  const app = acp
    .client({ name: "test" })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      updates.push(ctx.params.update);
      onUpdate?.(ctx.params.update);
    });
  const connection = (overAcp ? overAcp.serve(app) : app).connect(
    createAgent({ resolveModel, defaults: DEFAULTS }),
  );
  const agent = connection.agent;
  const init = await agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
  });
  for (const route of standard.routes ?? []) {
    await agent.request(acp.methods.agent.providers.set, route);
  }
  const { sessionId } = await agent.request(acp.methods.agent.session.new, {
    ...(standard.systemPrompt ? { systemPrompt: standard.systemPrompt } : {}),
    cwd: "/",
    mcpServers: overAcp
      ? [overAcp.server]
      : [{ type: "http", name: "stub", url: mcp?.url ?? "", headers: [] }],
    ...(meta ? { _meta: meta } : {}),
  });
  const prompt = (text: string) =>
    agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text }],
    });
  return { agent, sessionId, prompt, updates, init, close: () => connection.close() };
}

const text = (updates: acp.SessionUpdate[]) =>
  updates
    .flatMap((u) =>
      u.sessionUpdate === "agent_message_chunk" && u.content.type === "text"
        ? [u.content.text]
        : [],
    )
    .join("");

describe("the agent over plain ACP", () => {
  test("runs on its defaults and calls a tool from the client's MCP server", async () => {
    const { model, prompts } = recording([
      { toolCalls: [{ toolCallId: "t1", toolName: "lookup_order", input: '{"orderId":"8812"}' }] },
      { text: "Order 8812 shipped." },
    ]);
    const s = await session(model);
    const response = await s.prompt("Where is order 8812?");

    expect(response.stopReason).toBe("end_turn");
    expect(response._meta?.[STOP_REASON_META_KEY]).toBe("complete");
    expect(mcp?.calls).toEqual([{ orderId: "8812" }]);
    expect(text(s.updates).trim()).toBe("Order 8812 shipped.");
    expect(s.updates.some((u) => u.sessionUpdate === "tool_call")).toBe(true);
    expect(prompts[0]?.[0]).toMatchObject({ role: "system", content: "default system prompt" });
    s.close();
  });

  test("keeps the session's history across prompts", async () => {
    const { model, prompts } = recording([{ text: "first answer" }, { text: "second answer" }]);
    const s = await session(model);
    await s.prompt("one");
    await s.prompt("two");
    const seen = JSON.stringify(prompts.at(-1));
    expect(seen).toContain("one");
    expect(seen).toContain("first answer");
    expect(seen).toContain("two");
    s.close();
  });
});

describe("the agent with a host's session options", () => {
  test("takes the host's system prompt and history whole", async () => {
    const { model, prompts } = recording([{ text: "ok" }]);
    const s = await session(
      model,
      {
        [SESSION_META_KEY]: {
          history: encodeMessages([
            { role: "user", content: [{ type: "text", text: "earlier question" }] },
            { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
          ]),
        },
      },
      undefined,
      undefined,
      {
        systemPrompt: {
          mode: "override",
          content: [{ type: "text", text: "host system prompt" }],
        },
      },
    );
    await s.prompt("now");
    const [system, ...rest] = prompts[0] ?? [];
    expect(system).toMatchObject({ role: "system", content: "host system prompt" });
    expect(JSON.stringify(rest)).toContain("earlier answer");
    s.close();
  });
});

/** A long history: enough earlier exchanges to outgrow a small input budget. */
function longHistory(): string {
  const filler = "lorem ipsum dolor sit amet ".repeat(300);
  return encodeMessages(
    Array.from({ length: 12 }, (_, i) => [
      { role: "user" as const, content: [{ type: "text" as const, text: `q${i} ${filler}` }] },
      { role: "assistant" as const, content: [{ type: "text" as const, text: `a${i} ${filler}` }] },
    ]).flat(),
  );
}

const OVER_BUDGET = { maxInputTokens: 20_000, maxOutputTokens: 1_000 };

describe("the agent's usage report", () => {
  test("reports every model call of the turn, its cache-write TTL split, and their total", async () => {
    const { model } = recording(
      [
        {
          toolCalls: [{ toolCallId: "t1", toolName: "lookup_order", input: '{"orderId":"8812"}' }],
        },
        { text: "Order 8812 shipped." },
      ],
      [
        providerUsage({
          noCache: 200,
          cacheRead: 300,
          cacheWrite: 500,
          cacheWrite1h: 400,
          output: 50,
        }),
        providerUsage({
          noCache: 100,
          cacheRead: 800,
          cacheWrite: 120,
          cacheWrite1h: 0,
          output: 30,
        }),
      ],
    );
    const s = await session(model);
    const response = await s.prompt("Where is order 8812?");
    const usage = response._meta?.[USAGE_META_KEY] as TurnUsage;

    expect(usage.calls).toEqual([
      {
        model: DEFAULTS.model,
        purpose: "turn",
        usage: {
          inputTokens: 1_000,
          outputTokens: 50,
          cacheReadTokens: 300,
          cacheWriteTokens: 500,
          cacheWrite1hTokens: 400,
          reasoningTokens: 0,
        },
      },
      {
        model: DEFAULTS.model,
        purpose: "turn",
        usage: {
          inputTokens: 1_020,
          outputTokens: 30,
          cacheReadTokens: 800,
          cacheWriteTokens: 120,
          cacheWrite1hTokens: 0,
          reasoningTokens: 0,
        },
      },
    ]);
    expect(usage.total).toEqual({
      inputTokens: 2_020,
      outputTokens: 80,
      cacheReadTokens: 1_100,
      cacheWriteTokens: 620,
      cacheWrite1hTokens: 400,
      reasoningTokens: 0,
    });
    expect(response.usage).toEqual({
      inputTokens: 2_020,
      outputTokens: 80,
      totalTokens: 2_100,
      cachedReadTokens: 1_100,
      cachedWriteTokens: 620,
    });
    s.close();
  });
});

describe("a turn that fails on a model call", () => {
  /** A model whose first call answers from `first` and whose second fails with `failure`. */
  function failingSecondCall(failure: () => Error): LanguageModelV4 {
    const { model } = recording(
      [
        {
          toolCalls: [{ toolCallId: "t1", toolName: "lookup_order", input: '{"orderId":"8812"}' }],
        },
      ],
      [providerUsage({ noCache: 900, cacheRead: 0, cacheWrite: 0, output: 40 })],
    );
    let calls = 0;
    return {
      ...model,
      doStream: (options) => (++calls === 1 ? model.doStream(options) : Promise.reject(failure())),
    };
  }

  /** The AI SDK's error for a 429 whose body is not JSON, as a gateway's budget refusal is. */
  const gatewayRefusal = () =>
    Object.assign(new Error("Too Many Requests"), {
      name: "AI_APICallError",
      statusCode: 429,
      responseBody: "rate limit exceeded",
    });

  test("returns the call's status, the provider's reason and the turn's usage so far", async () => {
    const s = await session(failingSecondCall(gatewayRefusal));
    const failed = await s.prompt("Where is order 8812?").then(
      () => undefined,
      (err: unknown) => err,
    );
    s.close();

    expect(failed).toBeInstanceOf(acp.RequestError);
    const error = failed as acp.RequestError;
    expect(error.code).toBe(-32603);
    expect(error.message).toBe(
      "Internal error: model call failed with status 429: rate limit exceeded",
    );
    const data = error.data as Record<string, unknown>;
    expect(data[MODEL_ERROR_KEY]).toEqual({ status: 429, reason: "rate limit exceeded" });
    const usage = data[USAGE_META_KEY] as TurnUsage;
    expect(usage.calls).toHaveLength(1);
    expect(usage.total).toMatchObject({ inputTokens: 900, outputTokens: 40 });
  });

  test("never carries a credential the session holds, whatever the provider echoed", async () => {
    const echoed = () =>
      Object.assign(new Error("Unauthorized"), {
        name: "AI_APICallError",
        statusCode: 401,
        responseBody: '{"error":"bad token turn-jwt-secret-value"}',
      });
    const s = await session(failingSecondCall(echoed), undefined, undefined, undefined, {
      routes: [
        {
          providerId: "anthropic",
          apiType: "anthropic",
          baseUrl: "https://gateway.example/v1",
          headers: { Authorization: "Bearer turn-jwt-secret-value" },
        },
      ],
    });
    const failed = (await s
      .prompt("Where is order 8812?")
      .catch((err: unknown) => err)) as acp.RequestError;
    s.close();

    expect(JSON.stringify(failed.toErrorResponse())).not.toContain("turn-jwt-secret-value");
    expect((failed.data as Record<string, unknown>)[MODEL_ERROR_KEY]).toEqual({
      status: 401,
      reason: '{"error":"bad token [redacted]"}',
    });
  });

  test("leaves a failure that is not a model call as it was", async () => {
    const s = await session(failingSecondCall(() => new Error("something else broke")));
    const failed = (await s
      .prompt("Where is order 8812?")
      .catch((err: unknown) => err)) as acp.RequestError;
    s.close();

    expect(failed.code).toBe(-32603);
    expect(failed.message).toBe("Internal error");
    expect((failed.data as Record<string, unknown> | undefined)?.[MODEL_ERROR_KEY]).toBeUndefined();
  });
});

describe("the agent's mid-turn fold", () => {
  const toolTurn = (): EchoModelResponse[] => [
    { toolCalls: [{ toolCallId: "t1", toolName: "lookup_order", input: '{"orderId":"8812"}' }] },
    { text: "done" },
  ];

  test("is written by the session's compaction model and reported as a summary", async () => {
    const main = recording(toolTurn(), [
      providerUsage({
        noCache: 4_000,
        cacheRead: 0,
        cacheWrite: 1_000,
        cacheWrite1h: 1_000,
        output: 20,
      }),
      providerUsage({
        noCache: 3_000,
        cacheRead: 1_000,
        cacheWrite: 0,
        cacheWrite1h: 0,
        output: 10,
      }),
    ]);
    const summarizer = recording(
      [{ text: "summary of earlier exchanges" }],
      [providerUsage({ noCache: 9_000, cacheRead: 0, cacheWrite: 0, output: 300 })],
    );
    const resolved: string[] = [];
    const s = await session(
      (id) => {
        resolved.push(id);
        return id === "anthropic:claude-haiku-4-5" ? summarizer.model : main.model;
      },
      {
        [SESSION_META_KEY]: {
          ...OVER_BUDGET,
          history: longHistory(),
          compaction: { model: "anthropic:claude-haiku-4-5" },
        },
      },
    );
    const response = await s.prompt("Where is order 8812?");
    const usage = response._meta?.[USAGE_META_KEY] as TurnUsage;

    expect(resolved).toContain("anthropic:claude-haiku-4-5");
    expect(summarizer.prompts.length).toBeGreaterThan(0);
    expect(summarizer.prompts.length).toBe(1);
    expect(usage.calls.filter((c) => c.purpose === "summary")).toEqual([
      {
        model: "anthropic:claude-haiku-4-5",
        purpose: "summary",
        usage: {
          inputTokens: 9_000,
          outputTokens: 300,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      },
    ]);
    expect(usage.total).toEqual({
      inputTokens: 18_000,
      outputTokens: 330,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 1_000,
      cacheWrite1hTokens: 1_000,
      reasoningTokens: 0,
    });
    expect(response.usage?.inputTokens).toBe(18_000);
    s.close();
  });

  test("never runs when the session turns compaction off", async () => {
    const main = recording(toolTurn());
    const s = await session(main.model, {
      [SESSION_META_KEY]: { ...OVER_BUDGET, history: longHistory(), compaction: false },
    });
    const response = await s.prompt("Where is order 8812?");
    const usage = response._meta?.[USAGE_META_KEY] as TurnUsage;

    expect(response.stopReason).toBe("end_turn");
    expect(usage.calls.every((c) => c.purpose === "turn")).toBe(true);
    expect(main.prompts.length).toBe(2);
    s.close();
  });
});

describe("the agent's cancellation", () => {
  test("a cancel mid-tool ends the turn as cancelled", async () => {
    mcp = startStubMcp(() => "late");
    const { model } = recording([
      { toolCalls: [{ toolCallId: "t1", toolName: "lookup_order", input: '{"orderId":"1"}' }] },
      { text: "never" },
    ]);
    let cancel: (() => void) | undefined;
    const s = await session(model, undefined, (u) => {
      if (u.sessionUpdate === "tool_call") cancel?.();
    });
    cancel = () =>
      void s.agent.notify(acp.methods.agent.session.cancel, { sessionId: s.sessionId });
    const response = await s.prompt("go");
    expect(response.stopReason).toBe("cancelled");
    s.close();
  });
});

describe("the agent with tools on the ACP connection", () => {
  test("advertises acp MCP servers and calls a tool on one over the connection", async () => {
    const { model } = recording([
      { toolCalls: [{ toolCallId: "t1", toolName: "lookup_order", input: '{"orderId":"8812"}' }] },
      { text: "Order 8812 shipped." },
    ]);
    const overAcp = acpStubMcp((input) => `order ${input.orderId} shipped`);
    const s = await session(model, undefined, undefined, overAcp);
    expect(s.init.agentCapabilities?.mcpCapabilities).toMatchObject({ http: true, acp: true });

    const response = await s.prompt("Where is order 8812?");

    expect(response.stopReason).toBe("end_turn");
    expect(overAcp.calls).toEqual([{ orderId: "8812" }]);
    expect(text(s.updates).trim()).toBe("Order 8812 shipped.");
    s.close();
  });

  test("a cancel mid-tool ends the turn as cancelled and cancels the client's call", async () => {
    const { model } = recording([
      { toolCalls: [{ toolCallId: "t1", toolName: "lookup_order", input: '{"orderId":"1"}' }] },
      { text: "never" },
    ]);
    let cancel: (() => void) | undefined;
    // The call stays pending on the client, and the cancel goes out once the client has it.
    const overAcp = acpStubMcp(() => {
      cancel?.();
      return new Promise<string>(() => {});
    });
    const s = await session(model, undefined, undefined, overAcp);
    cancel = () =>
      void s.agent.notify(acp.methods.agent.session.cancel, { sessionId: s.sessionId });
    const response = await s.prompt("go");
    expect(response.stopReason).toBe("cancelled");
    expect(overAcp.calls).toEqual([{ orderId: "1" }]);
    expect(overAcp.cancelled).toHaveLength(1);
    s.close();
  });

  test("refuses an MCP server on a transport it does not take", async () => {
    const { model } = recording([{ text: "ok" }]);
    const connection = acp
      .client({ name: "test" })
      .connect(createAgent({ resolveModel: () => model, defaults: DEFAULTS }));
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
    });
    await expect(
      connection.agent.request(acp.methods.agent.session.new, {
        cwd: "/",
        mcpServers: [{ type: "sse", name: "old", url: "http://127.0.0.1:1/sse", headers: [] }],
      }),
    ).rejects.toThrow(/only http and acp are supported/);
    connection.close();
  });
});

describe("the session options ACP's own fields replaced", () => {
  test("are refused, naming the field to use", async () => {
    const { model } = recording([{ text: "ok" }]);
    const refused = async (options: Record<string, unknown>, use: RegExp) =>
      expect(session(model, { [SESSION_META_KEY]: options })).rejects.toThrow(use);
    await refused({ system: "x" }, /"system" is gone: use ACP's systemPrompt/);
    await refused({ modelCredential: "t" }, /"modelCredential" is gone: use ACP's providers\/set/);
    await refused({ modelEndpoint: "https://x.example/v1" }, /"modelEndpoint" is gone/);
    await refused({ modelEndpoints: {} }, /"modelEndpoints" is gone/);
  });
});

describe("the agent's provider routes", () => {
  test("reach the model resolver for every call of the session", async () => {
    const { model } = recording([{ text: "ok" }]);
    const accesses: (ModelAccess | undefined)[] = [];
    const route = {
      providerId: "anthropic",
      apiType: "anthropic",
      baseUrl: "https://gateway.example/anthropic/v1",
      headers: { Authorization: "Bearer turn-jwt" },
    };
    const s = await session(
      (_id, access) => {
        accesses.push(access);
        return model;
      },
      undefined,
      undefined,
      undefined,
      { routes: [route] },
    );
    await s.prompt("hi");
    expect(accesses.length).toBeGreaterThan(0);
    for (const access of accesses) {
      expect(access).toEqual({
        providers: { anthropic: { baseUrl: route.baseUrl, headers: route.headers } },
      });
    }
    s.close();
  });
});

describe("the agent's log lines", () => {
  test("name the session, its turn and its close, and never the credential", async () => {
    const info = spyOn(log, "info").mockImplementation(() => {});
    try {
      const { model } = recording([
        { toolCalls: [{ toolCallId: "t1", toolName: "lookup_order", input: '{"orderId":"1"}' }] },
        { text: "done" },
      ]);
      const s = await session(model, undefined, undefined, undefined, {
        routes: [
          {
            providerId: "anthropic",
            apiType: "anthropic",
            baseUrl: "https://gateway.example/v1?k=v",
            headers: { Authorization: "Bearer turn-jwt-secret" },
          },
        ],
      });
      await s.prompt("hi");
      await s.agent.request(acp.methods.agent.session.close, { sessionId: s.sessionId });
      s.close();

      const lines = info.mock.calls.map(([message, fields]) => ({ message, fields }));
      const of = (message: string) => lines.filter((l) => l.message === message);
      expect(of("[acp] session opened")).toEqual([
        {
          message: "[acp] session opened",
          fields: {
            session_id: s.sessionId,
            model: DEFAULTS.model,
            mcp_servers: 1,
            history_messages: 0,
            model_endpoint_host: "gateway.example",
          },
        },
      ]);
      const [ended] = of("[acp] turn ended");
      expect(ended?.fields).toMatchObject({
        session_id: s.sessionId,
        stop_reason: "complete",
        model_calls: 2,
      });
      expect(typeof (ended?.fields as { duration_ms?: unknown } | undefined)?.duration_ms).toBe(
        "number",
      );
      expect(of("[acp] session closed")).toEqual([
        { message: "[acp] session closed", fields: { session_id: s.sessionId } },
      ]);
      expect(JSON.stringify(info.mock.calls)).not.toContain("turn-jwt-secret");
    } finally {
      info.mockRestore();
    }
  });

  test("count the host's history in messages", async () => {
    const info = spyOn(log, "info").mockImplementation(() => {});
    try {
      const { model } = recording([{ text: "ok" }]);
      const s = await session(model, {
        [SESSION_META_KEY]: {
          history: encodeMessages([
            { role: "user", content: [{ type: "text", text: "earlier question" }] },
            { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
          ]),
        },
      });
      s.close();
      const opened = info.mock.calls.find(([message]) => message === "[acp] session opened");
      expect(opened?.[1]).toMatchObject({ history_messages: 2 });
    } finally {
      info.mockRestore();
    }
  });

  test("give a turn's token totals", async () => {
    const info = spyOn(log, "info").mockImplementation(() => {});
    try {
      const { model } = recording(
        [{ text: "ok" }],
        [
          providerUsage({
            noCache: 200,
            cacheRead: 300,
            cacheWrite: 500,
            cacheWrite1h: 0,
            output: 50,
          }),
        ],
      );
      const s = await session(model);
      await s.prompt("hi");
      s.close();
      const ended = info.mock.calls.find(([message]) => message === "[acp] turn ended");
      expect(ended?.[1]).toMatchObject({ input_tokens: 1_000, output_tokens: 50 });
    } finally {
      info.mockRestore();
    }
  });

  test("end a cancelled turn as cancelled", async () => {
    const info = spyOn(log, "info").mockImplementation(() => {});
    try {
      mcp = startStubMcp(() => "late");
      const { model } = recording([
        { toolCalls: [{ toolCallId: "t1", toolName: "lookup_order", input: '{"orderId":"1"}' }] },
        { text: "never" },
      ]);
      let cancel: (() => void) | undefined;
      const s = await session(model, undefined, (u) => {
        if (u.sessionUpdate === "tool_call") cancel?.();
      });
      cancel = () =>
        void s.agent.notify(acp.methods.agent.session.cancel, { sessionId: s.sessionId });
      await s.prompt("go");
      s.close();
      const ended = info.mock.calls.find(([message]) => message === "[acp] turn ended");
      expect(ended?.[1]).toMatchObject({ session_id: s.sessionId, stop_reason: "cancelled" });
    } finally {
      info.mockRestore();
    }
  });

  test("log a failed turn's error class and status, never its message", async () => {
    const written: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const format = process.env.NB_LOG_FORMAT;
    process.env.NB_LOG_FORMAT = "json";
    try {
      const echo = createEchoModel({ responses: [{ text: "never" }] });
      const rejected = () =>
        Object.assign(new Error("Rejected credential turn-jwt-secret"), {
          name: "AI_APICallError",
          statusCode: 401,
        });
      const model: LanguageModelV4 = {
        ...echo,
        doStream: () => Promise.reject(rejected()),
        doGenerate: () => Promise.reject(rejected()),
      };
      const s = await session(model, undefined, undefined, undefined, {
        routes: [
          {
            providerId: "anthropic",
            apiType: "anthropic",
            baseUrl: "https://gateway.example/v1",
            headers: { Authorization: "Bearer turn-jwt-secret" },
          },
        ],
      });
      await expect(s.prompt("hi")).rejects.toThrow();
      s.close();
      const failed = written
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.message === "[acp] turn failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        session_id: s.sessionId,
        error: "AI_APICallError",
        status: 401,
      });
      expect(written.join("")).not.toContain("turn-jwt-secret");
    } finally {
      if (format === undefined) delete process.env.NB_LOG_FORMAT;
      else process.env.NB_LOG_FORMAT = format;
      stderr.mockRestore();
    }
  });

  test("name the sessions still open when the connection drops", async () => {
    const info = spyOn(log, "info").mockImplementation(() => {});
    try {
      const { model } = recording([{ text: "ok" }]);
      const s = await session(model);
      s.close();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const closed = info.mock.calls.find(([message]) => message === "[acp] connection closed");
      expect(closed?.[1]).toEqual({ open_sessions: [s.sessionId] });
    } finally {
      info.mockRestore();
    }
  });
});
