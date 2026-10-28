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

async function callOnce(resolve: ReturnType<typeof createModelResolver>, credential?: string) {
  const model = resolve("anthropic:claude-sonnet-4-6", credential ? { credential } : undefined);
  await model
    .doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
    .catch(() => {});
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
