import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { SESSION_META_KEY, type SessionSettings } from "../../src/acp/session-options.ts";
import type { ModelAccess } from "../../src/model/resolve.ts";
import { CONNECTION_AUDIENCE, createConnectionAuth } from "../../src/serve/connection-auth.ts";
import { serveHttp, type Worker } from "../../src/serve/http.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { type StubMcp, startStubMcp } from "../helpers/stub-mcp.ts";

// nimblebrain-agent as a network worker: ACP over Streamable HTTP, a
// connection check on every request, many connections in one process, and a
// drain that lets the turns in flight finish.

const DEFAULTS: SessionSettings = {
  model: "anthropic:claude-sonnet-4-6",
  system: "s",
  maxIterations: 5,
  maxInputTokens: 100_000,
  maxOutputTokens: 1_000,
};
const ISSUER = "http://runtime.test";

let worker: Worker | undefined;
let keySet: ReturnType<typeof Bun.serve> | undefined;
let mcp: StubMcp | undefined;
afterEach(async () => {
  await worker?.stop();
  await keySet?.stop(true);
  await mcp?.close();
  worker = keySet = mcp = undefined;
});

/** The runtime's run key, and its key set served the way the runtime serves it. */
function runtimeKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  keySet = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1" }] }),
  });
  return { privateKey, jwksUrl: `http://127.0.0.1:${keySet.port}/.well-known/run-keys.json` };
}

function credential(privateKey: KeyObject, aud = CONNECTION_AUDIENCE): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: "EdDSA", typ: "JWT", kid: "k1" })}.${b64({ iss: ISSUER, aud, sub: "pool", iat: now, exp: now + 300 })}`;
  return `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`;
}

async function start(resolveModel: (model: string, access?: ModelAccess) => LanguageModelV4) {
  const { privateKey, jwksUrl } = runtimeKey();
  worker = await serveHttp(
    { resolveModel, defaults: DEFAULTS },
    {
      hostname: "127.0.0.1",
      port: 0,
      auth: createConnectionAuth({ jwksUrl, issuer: ISSUER }),
      drainMs: 5_000,
    },
  );
  return { url: worker.url, token: credential(privateKey), privateKey };
}

/** A client connection to the worker, presenting `token`. */
async function connect(url: string, token: string) {
  const updates: acp.SessionUpdate[] = [];
  const connection = acp
    .client({ name: "runtime" })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      updates.push(ctx.params.update);
    })
    .connect(createHttpStream(url, { headers: { authorization: `Bearer ${token}` } }));
  const agent = connection.agent;
  await agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION });
  mcp ??= startStubMcp((input) => `order ${input.orderId} shipped`);
  const open = (meta?: Record<string, unknown>) =>
    agent.request(acp.methods.agent.session.new, {
      cwd: "/",
      mcpServers: [{ type: "http", name: "stub", url: mcp?.url ?? "", headers: [] }],
      ...(meta ? { _meta: meta } : {}),
    });
  const prompt = (sessionId: string, text: string) =>
    agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text }],
    });
  return { agent, open, prompt, updates, close: () => connection.close() };
}

const echo = () => createEchoModel({ responses: [{ text: "hello" }, { text: "again" }] });

describe("nimblebrain-agent serve", () => {
  test("runs a turn over Streamable HTTP for a client with a valid credential", async () => {
    const { url, token } = await start(() => echo());
    const client = await connect(url, token);
    const { sessionId } = await client.open();
    const response = await client.prompt(sessionId, "hi");
    expect(response.stopReason).toBe("end_turn");
    client.close();
  });

  test("refuses a client without a credential, or with one for another audience", async () => {
    const { url, privateKey } = await start(() => echo());
    const noAuth = await fetch(url, { method: "POST", body: "{}" });
    expect(noAuth.status).toBe(401);
    const wrong = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${credential(privateKey, "model-gateway")}` },
      body: "{}",
    });
    expect(wrong.status).toBe(401);
  });

  test("a connection that closes ends only its own sessions", async () => {
    const { url, token } = await start(() => echo());
    const a = await connect(url, token);
    const b = await connect(url, token);
    await a.open();
    const { sessionId } = await b.open();
    a.close();
    await Bun.sleep(20);
    expect((await b.prompt(sessionId, "still here?")).stopReason).toBe("end_turn");
    b.close();
  });

  test("a session's model calls present the credential its client handed it", async () => {
    const seen: (ModelAccess | undefined)[] = [];
    const { url, token } = await start((_model, access) => {
      seen.push(access);
      return echo();
    });
    const client = await connect(url, token);
    const { sessionId } = await client.open({
      [SESSION_META_KEY]: { modelCredential: "turn-jwt" },
    });
    await client.prompt(sessionId, "hi");
    expect(seen.at(-1)).toEqual({ credential: "turn-jwt" });
    client.close();
  });

  test("draining finishes the turn in flight and refuses new sessions and connections", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: LanguageModelV4 = {
      ...echo(),
      async doStream(options) {
        await held;
        return createEchoModel({ responses: [{ text: "done" }] }).doStream(options);
      },
    };
    const { url, token } = await start(() => slow);
    const client = await connect(url, token);
    const { sessionId } = await client.open();
    const turn = client.prompt(sessionId, "take your time");
    await Bun.sleep(20);

    const drained = worker?.drain();
    await Bun.sleep(20);
    const ready = await fetch(url.replace("/acp", "/readyz"));
    expect(ready.status).toBe(503);
    await expect(client.open()).rejects.toThrow(/draining/);
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: "{}",
        })
      ).status,
    ).toBe(503);

    // The turn's response reaches the client before the drain closes the connection.
    release();
    expect((await turn).stopReason).toBe("end_turn");
    client.close();
    await drained;
    worker = undefined;
  });

  test("will not serve beyond loopback without a connection check", async () => {
    await expect(
      serveHttp(
        { resolveModel: () => echo(), defaults: DEFAULTS },
        { hostname: "0.0.0.0", port: 0, auth: null, drainMs: 1 },
      ),
    ).rejects.toThrow(/only loopback/);
  });
});
