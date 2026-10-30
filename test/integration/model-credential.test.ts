import { afterEach, expect, test } from "bun:test";
import { createModelResolver, type ProviderRoute } from "../../src/model/resolve.ts";

// A session's model credential reaches the gateway as `Authorization: Bearer`,
// in place of the worker's provider key.

let gateway: ReturnType<typeof Bun.serve> | undefined;
afterEach(async () => {
  await gateway?.stop(true);
  gateway = undefined;
});

function startGateway(seen: Headers[]) {
  gateway = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      seen.push(req.headers);
      return Response.json(
        { error: { type: "authentication_error", message: "stop here" } },
        { status: 401 },
      );
    },
  });
  return `http://127.0.0.1:${gateway.port}/v1`;
}

async function callOnce(
  resolve: ReturnType<typeof createModelResolver>,
  credential?: string,
  endpoint?: string,
  modelName = "anthropic:claude-sonnet-4-6",
) {
  const model = resolve(modelName, credential ? { credential, endpoint } : undefined);
  try {
    await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  } catch {
    // The gateway refuses every call; the test reads the request it saw.
  }
}

test("anthropic: a session credential is the bearer, and the worker's key is not sent", async () => {
  const seen: Headers[] = [];
  const resolve = createModelResolver({
    ANTHROPIC_API_KEY: "worker-key",
    ANTHROPIC_BASE_URL: startGateway(seen),
  });
  await callOnce(resolve, "turn-jwt");
  expect(seen[0]?.get("authorization")).toBe("Bearer turn-jwt");
  expect(seen[0]?.get("x-api-key")).toBeNull();

  await callOnce(resolve);
  expect(seen.at(-1)?.get("x-api-key")).toBe("worker-key");
});

test("a session credential needs no provider key in the environment", async () => {
  const seen: Headers[] = [];
  const resolve = createModelResolver({ ANTHROPIC_BASE_URL: startGateway(seen) });
  await callOnce(resolve, "turn-jwt");
  expect(seen[0]?.get("authorization")).toBe("Bearer turn-jwt");
});

// How each provider presents the worker's own key, and the variables it is configured from.
const providers = [
  {
    model: "anthropic:claude-sonnet-4-6",
    keyVar: "ANTHROPIC_API_KEY",
    baseVar: "ANTHROPIC_BASE_URL",
    workerKey: (h: Headers) => h.get("x-api-key"),
    workerKeySent: "worker-key",
  },
  {
    model: "openai:gpt-5",
    keyVar: "OPENAI_API_KEY",
    baseVar: "OPENAI_BASE_URL",
    workerKey: (h: Headers) => h.get("authorization"),
    workerKeySent: "Bearer worker-key",
  },
  {
    model: "google:gemini-3-pro",
    keyVar: "GOOGLE_GENERATIVE_AI_API_KEY",
    baseVar: "GOOGLE_GENERATIVE_AI_BASE_URL",
    workerKey: (h: Headers) => h.get("x-goog-api-key"),
    workerKeySent: "worker-key",
  },
  {
    model: "xai:grok-4",
    keyVar: "XAI_API_KEY",
    baseVar: "XAI_BASE_URL",
    workerKey: (h: Headers) => h.get("authorization"),
    workerKeySent: "Bearer worker-key",
  },
  {
    model: "nebius:Qwen/Qwen3-235B-A22B-Instruct-2507",
    keyVar: "NEBIUS_API_KEY",
    baseVar: "NEBIUS_BASE_URL",
    workerKey: (h: Headers) => h.get("authorization"),
    workerKeySent: "Bearer worker-key",
  },
  {
    model: "greenpt:gpt-oss-120b",
    keyVar: "GREENPT_API_KEY",
    baseVar: "GREENPT_BASE_URL",
    workerKey: (h: Headers) => h.get("authorization"),
    workerKeySent: "Bearer worker-key",
  },
];

for (const p of providers) {
  test(`${p.model.split(":")[0]}: a session endpoint takes the session's calls, but only beside its own credential`, async () => {
    const workerSeen: Headers[] = [];
    const workerGateway = startGateway(workerSeen);
    const sessionSeen: Headers[] = [];
    const sessionGatewayServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        sessionSeen.push(req.headers);
        return Response.json(
          { error: { type: "authentication_error", message: "no" } },
          { status: 401 },
        );
      },
    });
    const sessionGateway = `http://127.0.0.1:${sessionGatewayServer.port}/v1`;
    try {
      const resolve = createModelResolver({
        [p.keyVar]: "worker-key",
        [p.baseVar]: workerGateway,
      });
      await callOnce(resolve, "turn-jwt", sessionGateway, p.model);
      expect(sessionSeen.map((h) => h.get("authorization"))).toEqual(["Bearer turn-jwt"]);
      // No header a provider key travels in reaches the session's endpoint.
      expect(sessionSeen.map((h) => [h.get("x-api-key"), h.get("x-goog-api-key")])).toEqual([
        [null, null],
      ]);
      expect(workerSeen).toEqual([]);

      // Without the session's own access, the worker's key goes only to the worker's endpoint.
      await callOnce(resolve, undefined, undefined, p.model);
      expect(sessionSeen).toHaveLength(1);
      expect(workerSeen.map(p.workerKey)).toEqual([p.workerKeySent]);
    } finally {
      await sessionGatewayServer.stop(true);
    }
  });
}

test("a call goes to its provider's own endpoint, ahead of the session's one endpoint", async () => {
  const shared: string[] = [];
  const own: string[] = [];
  const serve = (paths: string[]) =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        paths.push(new URL(req.url).pathname);
        return Response.json({ error: { message: "no" } }, { status: 401 });
      },
    });
  const sharedServer = serve(shared);
  const ownServer = serve(own);
  try {
    const resolve = createModelResolver({});
    const access = {
      credential: "turn-jwt",
      endpoint: `http://127.0.0.1:${sharedServer.port}/v1`,
      endpoints: { google: `http://127.0.0.1:${ownServer.port}/google/v1beta` },
    };
    const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }];
    for (const model of ["google:gemini-3-pro", "anthropic:claude-sonnet-4-6"]) {
      try {
        await resolve(model, access).doGenerate({ prompt });
      } catch {
        // Both refuse; the test reads where each call went.
      }
    }
    expect(own).toEqual(["/google/v1beta/models/gemini-3-pro:generateContent"]);
    expect(shared).toEqual(["/v1/messages"]);
  } finally {
    await sharedServer.stop(true);
    await ownServer.stop(true);
  }
});

// The OpenAI-compatible providers ask for streamed usage (else every call meters
// at zero) and send a response format's schema as given.
for (const model of ["nebius:Qwen/Qwen3-235B-A22B-Instruct-2507", "greenpt:gpt-oss-120b"]) {
  test(`${model.split(":")[0]}: a streamed call asks for usage, keeps the schema, and reads the usage back`, async () => {
    const bodies: Record<string, unknown>[] = [];
    const chunk = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
    const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: "m" };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        bodies.push((await req.json()) as Record<string, unknown>);
        const sse =
          chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "{}" } }] }) +
          chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
          chunk({ ...base, choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } }) +
          "data: [DONE]\n\n";
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const schema = {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      } as const;
      const resolve = createModelResolver({});
      const { stream } = await resolve(model, {
        credential: "turn-jwt",
        endpoint: `http://127.0.0.1:${server.port}/v1`,
      }).doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        responseFormat: { type: "json", schema, name: "reply" },
      });
      const parts: { type: string; usage?: unknown }[] = [];
      for await (const part of stream) parts.push(part);

      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.stream_options).toEqual({ include_usage: true });
      expect(bodies[0]?.response_format).toMatchObject({
        type: "json_schema",
        json_schema: { name: "reply", schema },
      });
      const finish = parts.find((p) => p.type === "finish");
      expect(finish?.usage).toMatchObject({
        inputTokens: { total: 11 },
        outputTokens: { total: 7 },
      });
    } finally {
      await server.stop(true);
    }
  });
}

// A route the client set with ACP's `providers/set` sends the provider's calls to
// its base URL with its headers alone: no worker key, and nothing at all when the
// headers are empty. A disabled provider refuses the call.
test("a providers/set route carries its own headers and never the worker's key", async () => {
  const paths: string[] = [];
  const seen: Headers[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      paths.push(new URL(req.url).pathname);
      seen.push(req.headers);
      return Response.json({ error: { message: "no" } }, { status: 401 });
    },
  });
  try {
    const resolve = createModelResolver({
      ANTHROPIC_API_KEY: "worker-key",
      XAI_API_KEY: "worker-key",
    });
    const base = `http://127.0.0.1:${server.port}`;
    const prompt = [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }];
    const call = async (model: string, providers: Record<string, ProviderRoute>) => {
      try {
        await resolve(model, { providers }).doGenerate({ prompt });
      } catch {
        // Refused by the stand-in; the request is what is read.
      }
    };
    await call("anthropic:claude-sonnet-4-6", {
      anthropic: { baseUrl: `${base}/anthropic/v1`, headers: { authorization: "Bearer turn-jwt" } },
    });
    await call("xai:grok-4", { xai: { baseUrl: `${base}/xai/v1`, headers: {} } });
    // A route wins over the session's credential and endpoints for its provider.
    try {
      await resolve("anthropic:claude-sonnet-4-6", {
        providers: { anthropic: { baseUrl: `${base}/routed/v1`, headers: {} } },
        credential: "session-credential",
        endpoint: `${base}/endpoint/v1`,
        endpoints: { anthropic: `${base}/endpoints/v1` },
      }).doGenerate({ prompt });
    } catch {
      // Refused by the stand-in; the request is what is read.
    }

    expect(paths).toEqual([
      "/anthropic/v1/messages",
      "/xai/v1/chat/completions",
      "/routed/v1/messages",
    ]);
    expect(seen[0]?.get("authorization")).toBe("Bearer turn-jwt");
    expect(seen[0]?.get("x-api-key")).toBeNull();
    expect(seen[1]?.get("authorization")).toBeNull();
    expect(seen[2]?.get("authorization")).toBeNull();
    expect(seen[2]?.get("x-api-key")).toBeNull();

    expect(() => resolve("openai:gpt-5", { providers: { openai: null } })).toThrow(
      /"openai" is disabled/,
    );
  } finally {
    await server.stop(true);
  }
});
