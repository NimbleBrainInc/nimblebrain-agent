import { afterEach, describe, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk/unstable";
import type { LanguageModelV4, LanguageModelV4Prompt } from "@ai-sdk/provider";
import { createAgent } from "../../src/acp/agent.ts";
import {
  encodeMessages,
  SESSION_META_KEY,
  type SessionSettings,
  STOP_REASON_META_KEY,
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
    },
  };
}

async function session(
  model: LanguageModelV4,
  meta?: Record<string, unknown>,
  onUpdate?: (u: acp.SessionUpdate) => void,
) {
  mcp ??= startStubMcp((input) => `order ${input.orderId} shipped`);
  const updates: acp.SessionUpdate[] = [];
  const connection = acp
    .client({ name: "test" })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      updates.push(ctx.params.update);
      onUpdate?.(ctx.params.update);
    })
    .connect(createAgent({ resolveModel: () => model, defaults: DEFAULTS }));
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
