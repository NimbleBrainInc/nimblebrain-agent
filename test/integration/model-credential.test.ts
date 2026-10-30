import { afterEach, expect, test } from "bun:test";
import { createModelResolver, type ProviderRoute } from "../../src/model/resolve.ts";

// A session's provider routes (ACP's `providers/set`) send each provider's calls
// to the client's base URL with the client's headers, in place of the worker's
// provider key and endpoint.

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

/** A route to `baseUrl` presenting `credential` as a bearer, as a host sets one. */
const bearerRoute = (baseUrl: string, credential: string): ProviderRoute => ({
  baseUrl,
  headers: { Authorization: `Bearer ${credential}` },
});

async function callOnce(
  resolve: ReturnType<typeof createModelResolver>,
  route?: ProviderRoute,
  modelName = "anthropic:claude-sonnet-4-6",
) {
  const provider = modelName.slice(0, modelName.indexOf(":"));
  const model = resolve(modelName, route ? { providers: { [provider]: route } } : undefined);
  try {
    await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
  } catch {
    // The gateway refuses every call; the test reads the request it saw.
  }
}

test("a route needs no provider key in the environment", async () => {
  const seen: Headers[] = [];
  const resolve = createModelResolver({});
  await callOnce(resolve, bearerRoute(startGateway(seen), "turn-jwt"));
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
  test(`${p.model.split(":")[0]}: a route takes the session's calls with its own headers, and the worker's key goes nowhere else`, async () => {
    const workerSeen: Headers[] = [];
    const workerGateway = startGateway(workerSeen);
    const routeSeen: Headers[] = [];
    const routeServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        routeSeen.push(req.headers);
        return Response.json(
          { error: { type: "authentication_error", message: "no" } },
          { status: 401 },
        );
      },
    });
    try {
      const resolve = createModelResolver({
        [p.keyVar]: "worker-key",
        [p.baseVar]: workerGateway,
      });
      await callOnce(
        resolve,
        bearerRoute(`http://127.0.0.1:${routeServer.port}/v1`, "turn-jwt"),
        p.model,
      );
      expect(routeSeen.map((h) => h.get("authorization"))).toEqual(["Bearer turn-jwt"]);
      // No header a provider key travels in reaches the route.
      expect(routeSeen.map((h) => [h.get("x-api-key"), h.get("x-goog-api-key")])).toEqual([
        [null, null],
      ]);
      expect(workerSeen).toEqual([]);

      // Without a route, the worker's key goes only to the worker's endpoint.
      await callOnce(resolve, undefined, p.model);
      expect(routeSeen).toHaveLength(1);
      expect(workerSeen.map(p.workerKey)).toEqual([p.workerKeySent]);
    } finally {
      await routeServer.stop(true);
    }
  });
}

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
      const provider = model.slice(0, model.indexOf(":"));
      const { stream } = await resolve(model, {
        providers: {
          [provider]: bearerRoute(`http://127.0.0.1:${server.port}/v1`, "turn-jwt"),
        },
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
    expect(paths).toEqual(["/anthropic/v1/messages", "/xai/v1/chat/completions"]);
    expect(seen[0]?.get("authorization")).toBe("Bearer turn-jwt");
    expect(seen[0]?.get("x-api-key")).toBeNull();
    expect(seen[1]?.get("authorization")).toBeNull();

    expect(() => resolve("openai:gpt-5", { providers: { openai: null } })).toThrow(
      /"openai" is disabled/,
    );
  } finally {
    await server.stop(true);
  }
});
