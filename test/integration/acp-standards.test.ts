import { describe, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk/unstable";
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { createAgent } from "../../src/acp/agent.ts";
import { SESSION_META_KEY, type SessionSettings } from "../../src/acp/session-options.ts";
import type { ModelAccess } from "../../src/model/resolve.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

// The standard ACP fields a client can use in place of nimblebrain-agent's own
// session options: `systemPrompt` on `session/new`, and `providers/*`.

const DEFAULTS: SessionSettings = {
  model: "anthropic:claude-sonnet-4-6",
  system: "default system prompt",
  maxIterations: 3,
  maxInputTokens: 100_000,
  maxOutputTokens: 1_000,
};

/** A connection to a fresh agent, recording each prompt and each model access it resolves. */
async function connect(env: Record<string, string | undefined> = {}) {
  const prompts: LanguageModelV4Prompt[] = [];
  const accesses: (ModelAccess | undefined)[] = [];
  const echo = createEchoModel({ responses: [{ text: "ok" }] });
  const model = {
    ...echo,
    async doStream(options: Parameters<typeof echo.doStream>[0]) {
      prompts.push(options.prompt);
      return echo.doStream(options);
    },
  };
  const connection = acp.client({ name: "test" }).connect(
    createAgent({
      resolveModel: (_id, access) => {
        accesses.push(access);
        return model;
      },
      defaults: DEFAULTS,
      env,
    }),
  );
  const { agent } = connection;
  const init = await agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
  });
  const open = async (params: Partial<acp.NewSessionRequest> = {}) => {
    const { sessionId } = await agent.request(acp.methods.agent.session.new, {
      cwd: "/",
      mcpServers: [],
      ...params,
    });
    return sessionId;
  };
  const prompt = (sessionId: string) =>
    agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });
  const turn = async (params: Partial<acp.NewSessionRequest> = {}) => prompt(await open(params));
  return { agent, init, open, prompt, turn, prompts, accesses, close: () => connection.close() };
}

const text = (t: string): acp.ContentBlock => ({ type: "text", text: t });

describe("systemPrompt", () => {
  test("is advertised, append and override", async () => {
    const c = await connect();
    expect(c.init.agentCapabilities?.sessionCapabilities?.systemPrompt).toEqual({
      mode: { override: {} },
    });
    c.close();
  });

  test("override replaces the agent's own prompt; append adds to it", async () => {
    const c = await connect();
    await c.turn({ systemPrompt: { mode: "override", content: [text("host prompt")] } });
    await c.turn({ systemPrompt: { mode: "append", content: [text("one"), text("two")] } });
    expect(c.prompts[0]?.[0]).toMatchObject({ role: "system", content: "host prompt" });
    expect(c.prompts[1]?.[0]).toMatchObject({
      role: "system",
      content: "default system prompt\n\none\n\ntwo",
    });
    c.close();
  });

  test("wins over the session option's system prompt", async () => {
    const c = await connect();
    await c.turn({
      systemPrompt: { mode: "override", content: [text("standard")] },
      _meta: { [SESSION_META_KEY]: { system: "option" } },
    });
    expect(c.prompts[0]?.[0]).toMatchObject({ role: "system", content: "standard" });
    c.close();
  });

  test("refuses a mode it does not support and content other than text", async () => {
    const c = await connect();
    await expect(
      c.turn({ systemPrompt: { mode: "_custom", content: [text("x")] } }),
    ).rejects.toThrow(/mode "_custom" is not supported/);
    await expect(
      c.turn({
        systemPrompt: {
          mode: "append",
          content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
        },
      }),
    ).rejects.toThrow(/text content only/);
    c.close();
  });
});

describe("providers", () => {
  test("lists every provider with its protocol and the process's route, never a header", async () => {
    const c = await connect({ OPENAI_BASE_URL: "https://proxy.example/v1" });
    expect(c.init.agentCapabilities?.providers).toEqual({});
    const { providers } = await c.agent.request(acp.methods.agent.providers.list, {});
    const byId = Object.fromEntries(providers.map((p) => [p.providerId, p]));
    expect(Object.keys(byId)).toEqual([
      "anthropic",
      "openai",
      "google",
      "xai",
      "nebius",
      "greenpt",
    ]);
    expect(byId.anthropic).toEqual({
      providerId: "anthropic",
      supported: ["anthropic"],
      required: false,
      current: { apiType: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
    });
    expect(byId.openai?.current?.baseUrl).toBe("https://proxy.example/v1");
    expect(byId.google?.supported).toEqual(["gemini"]);
    expect(byId.nebius?.supported).toEqual(["openai"]);
    c.close();
  });

  test("a set route reaches the session's model access, and the list shows it without headers", async () => {
    const c = await connect();
    const route = {
      providerId: "anthropic",
      apiType: "anthropic",
      baseUrl: "https://gateway.example/anthropic/v1",
      headers: { Authorization: "Bearer turn-jwt" },
    };
    await c.agent.request(acp.methods.agent.providers.set, route);
    await c.agent.request(acp.methods.agent.providers.disable, { providerId: "openai" });
    await c.turn();

    expect(c.accesses.at(-1)).toEqual({
      providers: {
        anthropic: { baseUrl: route.baseUrl, headers: route.headers },
        openai: null,
      },
    });
    const { providers } = await c.agent.request(acp.methods.agent.providers.list, {});
    const listed = JSON.stringify(providers);
    expect(listed).not.toContain("turn-jwt");
    expect(providers.find((p) => p.providerId === "anthropic")?.current?.baseUrl).toBe(
      route.baseUrl,
    );
    expect(providers.find((p) => p.providerId === "openai")?.current).toBeNull();
    c.close();
  });

  test("a session keeps the routes it opened with; a later set or disable reaches new sessions only", async () => {
    const c = await connect();
    const route = (baseUrl: string) => ({
      providerId: "anthropic",
      apiType: "anthropic",
      baseUrl,
      headers: {},
    });
    await c.agent.request(acp.methods.agent.providers.set, route("https://first.example/v1"));
    const earlier = await c.open();
    await c.agent.request(acp.methods.agent.providers.set, route("https://second.example/v1"));
    await c.agent.request(acp.methods.agent.providers.disable, { providerId: "openai" });
    const later = await c.open();

    await c.prompt(earlier);
    expect(c.accesses.at(-1)).toEqual({
      providers: { anthropic: { baseUrl: "https://first.example/v1", headers: {} } },
    });
    await c.prompt(later);
    expect(c.accesses.at(-1)).toEqual({
      providers: { anthropic: { baseUrl: "https://second.example/v1", headers: {} }, openai: null },
    });
    c.close();
  });

  test("routes are the connection's own: another connection starts on the process's", async () => {
    const a = await connect();
    const b = await connect();
    await a.agent.request(acp.methods.agent.providers.set, {
      providerId: "anthropic",
      apiType: "anthropic",
      baseUrl: "https://gateway.example/anthropic/v1",
      headers: {},
    });
    await b.turn();
    expect(b.accesses.at(-1)).toBeUndefined();
    a.close();
    b.close();
  });

  test("refuses an unknown provider, a protocol it does not speak, and a base URL that is not one", async () => {
    const c = await connect();
    const set = (p: Partial<acp.SetProviderRequest>) =>
      c.agent.request(acp.methods.agent.providers.set, {
        providerId: "anthropic",
        apiType: "anthropic",
        baseUrl: "https://gateway.example/v1",
        ...p,
      });
    await expect(set({ providerId: "mistral" })).rejects.toThrow(/unknown provider "mistral"/);
    await expect(set({ apiType: "openai" })).rejects.toThrow(/speaks anthropic, not openai/);
    await expect(set({ baseUrl: "not a url" })).rejects.toThrow(/not a URL/);
    // Disabling a provider it does not know is already done.
    await c.agent.request(acp.methods.agent.providers.disable, { providerId: "mistral" });
    c.close();
  });
});
