import { afterEach, describe, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk/unstable";
import type { LanguageModelV4, LanguageModelV4Prompt } from "@ai-sdk/provider";
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

/** A model that records every prompt it is sent, answering from a script. */
function recording(script: EchoModelResponse[]): {
  model: LanguageModelV4;
  prompts: LanguageModelV4Prompt[];
} {
  const prompts: LanguageModelV4Prompt[] = [];
  const echo = createEchoModel({ responses: script });
  return {
    prompts,
    model: {
      ...echo,
      doStream(options) {
        prompts.push(options.prompt);
        return echo.doStream(options);
      },
      doGenerate(options) {
        prompts.push(options.prompt);
        return echo.doGenerate(options);
      },
    },
  };
}

async function session(
  model: LanguageModelV4 | ((id: string) => LanguageModelV4),
  meta?: Record<string, unknown>,
  onUpdate?: (u: acp.SessionUpdate) => void,
) {
  const resolveModel = typeof model === "function" ? model : () => model;
  mcp ??= startStubMcp((input) => `order ${input.orderId} shipped`);
  const updates: acp.SessionUpdate[] = [];
  const connection = acp
    .client({ name: "test" })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      updates.push(ctx.params.update);
      onUpdate?.(ctx.params.update);
    })
    .connect(createAgent({ resolveModel, defaults: DEFAULTS }));
  const agent = connection.agent;
  await agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION });
  const { sessionId } = await agent.request(acp.methods.agent.session.new, {
    cwd: "/",
    mcpServers: [{ type: "http", name: "stub", url: mcp.url, headers: [] }],
    ...(meta ? { _meta: meta } : {}),
  });
  const prompt = (text: string) =>
    agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text }],
    });
  return { agent, sessionId, prompt, updates, close: () => connection.close() };
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
  test("reports every model call of the turn and their total", async () => {
    const { model } = recording([
      { toolCalls: [{ toolCallId: "t1", toolName: "lookup_order", input: '{"orderId":"8812"}' }] },
      { text: "Order 8812 shipped." },
    ]);
    const s = await session(model);
    const response = await s.prompt("Where is order 8812?");
    const usage = response._meta?.[USAGE_META_KEY] as TurnUsage;

    expect(usage.calls.map((c) => [c.model, c.purpose])).toEqual([
      [DEFAULTS.model, "turn"],
      [DEFAULTS.model, "turn"],
    ]);
    const sum = (k: "inputTokens" | "outputTokens") =>
      usage.calls.reduce((n, c) => n + c.usage[k], 0);
    expect(usage.total.inputTokens).toBe(sum("inputTokens"));
    expect(usage.total.outputTokens).toBe(sum("outputTokens"));
    expect(response.usage?.inputTokens).toBe(usage.total.inputTokens);
    s.close();
  });
});

describe("the agent's mid-turn fold", () => {
  const toolTurn = (): EchoModelResponse[] => [
    { toolCalls: [{ toolCallId: "t1", toolName: "lookup_order", input: '{"orderId":"8812"}' }] },
    { text: "done" },
  ];

  test("is written by the session's compaction model and reported as a summary", async () => {
    const main = recording(toolTurn());
    const summarizer = recording([{ text: "summary of earlier exchanges" }]);
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
    expect(usage.calls.filter((c) => c.purpose === "summary").map((c) => c.model)).toEqual(
      summarizer.prompts.map(() => "anthropic:claude-haiku-4-5"),
    );
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
