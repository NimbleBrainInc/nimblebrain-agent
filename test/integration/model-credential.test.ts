import { afterEach, expect, test } from "bun:test";
import { createModelResolver } from "../../src/model/resolve.ts";

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
) {
  const model = resolve(
    "anthropic:claude-sonnet-4-6",
    credential || endpoint ? { credential, endpoint } : undefined,
  );
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

test("a session endpoint takes the session's calls, but only beside its own credential", async () => {
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
      ANTHROPIC_API_KEY: "worker-key",
      ANTHROPIC_BASE_URL: workerGateway,
    });
    await callOnce(resolve, "turn-jwt", sessionGateway);
    expect(sessionSeen.map((h) => h.get("authorization"))).toEqual(["Bearer turn-jwt"]);
    expect(workerSeen).toEqual([]);

    // Without the session's own credential the endpoint is ignored: the worker's
    // key never goes to an address a client named.
    await callOnce(resolve, undefined, sessionGateway);
    expect(sessionSeen).toHaveLength(1);
    expect(workerSeen.map((h) => h.get("x-api-key"))).toEqual(["worker-key"]);
  } finally {
    await sessionGatewayServer.stop(true);
  }
});
