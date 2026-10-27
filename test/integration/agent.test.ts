import { afterEach, describe, expect, test } from "bun:test";
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
  SESSION_META_KEY,
  type SessionSettings,
  STOP_REASON_META_KEY,
  type TurnUsage,
  USAGE_META_KEY,
} from "../../src/acp/session-options.ts";
import { createEchoModel, type EchoModelResponse } from "../helpers/echo-model.ts";
import { type AcpStubMcp, acpStubMcp } from "../helpers/acp-stub-mcp.ts";
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
  model: LanguageModelV4 | ((id: string) => LanguageModelV4),
  meta?: Record<string, unknown>,
  onUpdate?: (u: acp.SessionUpdate) => void,
  overAcp?: AcpStubMcp,
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
  const { sessionId } = await agent.request(acp.methods.agent.session.new, {
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
    const s = await session(model, {
      [SESSION_META_KEY]: {
        system: "host system prompt",
        history: encodeMessages([
          { role: "user", content: [{ type: "text", text: "earlier question" }] },
          { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
        ]),
      },
    });
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
