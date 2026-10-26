import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { type FakeAnthropic, startFakeAnthropic } from "../helpers/fake-anthropic.ts";
import { type StubMcp, startStubMcp } from "../helpers/stub-mcp.ts";

// `nimblebrain-agent acp` as a client starts it: a child process on stdio, its model
// reached through its provider SDK, its tools through an MCP server, and
// nothing else running.

const CLI = join(import.meta.dir, "../../src/cli.ts");

let model: FakeAnthropic;
let mcp: StubMcp;
beforeAll(() => {
  model = startFakeAnthropic();
  mcp = startStubMcp((input) => `order ${input.orderId} shipped Oct 20`);
});
afterAll(async () => {
  await model.close();
  await mcp.close();
});

function spawnAgent() {
  const child = Bun.spawn([process.execPath, "--no-env-file", CLI, "acp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      NB_AGENT_MODEL: "anthropic:claude-sonnet-4-6",
      NB_AGENT_SYSTEM_PROMPT: "You are a test agent.",
      ANTHROPIC_API_KEY: "test-key",
      ANTHROPIC_BASE_URL: model.baseUrl,
    },
  });
  const stdin = new WritableStream<Uint8Array>({
    async write(chunk) {
      child.stdin.write(chunk);
      await child.stdin.flush();
    },
    close() {
      void child.stdin.end();
    },
  });
  return { child, stream: acp.ndJsonStream(stdin, child.stdout) };
}

describe("nimblebrain-agent acp on stdio", () => {
  test("prints its version", async () => {
    const out = Bun.spawnSync([process.execPath, "--no-env-file", CLI, "--version"]);
    expect(out.stdout.toString()).toMatch(/^nimblebrain-agent \d+\.\d+\.\d+/);
  });

  test("completes a tool-using task for a plain ACP client, then exits when it disconnects", async () => {
    const { child, stream } = spawnAgent();
    const updates: acp.SessionUpdate[] = [];
    const connection = acp
      .client({ name: "test" })
      .onNotification(
        acp.methods.client.session.update,
        (ctx) => void updates.push(ctx.params.update),
      )
      .connect(stream);
    const agent = connection.agent;

    const init = await agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
    });
    expect(init.agentInfo?.name).toBe("nimblebrain-agent");
    const { sessionId } = await agent.request(acp.methods.agent.session.new, {
      cwd: "/",
      mcpServers: [{ type: "http", name: "orders", url: mcp.url, headers: [] }],
    });
    const response = await agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "Where is order 8812?" }],
    });

    expect(response.stopReason).toBe("end_turn");
    expect(mcp.calls).toEqual([{ orderId: "8812" }]);
    const reply = updates
      .flatMap((u) =>
        u.sessionUpdate === "agent_message_chunk" && u.content.type === "text"
          ? [u.content.text]
          : [],
      )
      .join("");
    expect(reply).toContain("order 8812 shipped Oct 20");
    // The model saw the system prompt nimblebrain-agent was started with, and the tool by name.
    expect(JSON.stringify(model.requests[0]?.system)).toContain("You are a test agent.");
    expect(model.requests[0]?.tools?.map((t) => t.name)).toEqual(["lookup_order"]);

    connection.close();
    await child.stdin.end();
    const code = await Promise.race([child.exited, Bun.sleep(5_000).then(() => "timeout")]);
    expect(code).not.toBe("timeout");
  }, 30_000);
});
