import { describe, expect, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk/unstable";
import type { JSONRPCMessage } from "@modelcontextprotocol/client";
import { acpMcpTransport, MCP_MESSAGE } from "../../src/acp/acp-mcp-transport.ts";

/** A client side that records what the transport sends, and answers when told. */
function fakeClient() {
  const requests: {
    method: string;
    params: unknown;
    signal?: AbortSignal;
    answer(a: unknown): void;
  }[] = [];
  const notifications: { method: string; params: unknown }[] = [];
  const client = {
    request(method: string, params: unknown, options?: { cancellationSignal?: AbortSignal }) {
      return new Promise((resolve) =>
        requests.push({ method, params, signal: options?.cancellationSignal, answer: resolve }),
      );
    },
    async notify(method: string, params: unknown) {
      notifications.push({ method, params });
    },
  } as unknown as acp.AgentContext;
  return { client, requests, notifications };
}

describe("MCP over the ACP connection, agent side", () => {
  test("a request goes as mcp/message for the server, and its answer comes back by id", async () => {
    const { client, requests } = fakeClient();
    const transport = acpMcpTransport(client, "srv_1");
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (m) => received.push(m);

    await transport.send({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} });
    expect(requests.map((r) => [r.method, r.params])).toEqual([
      [MCP_MESSAGE, { serverId: "srv_1", requestId: "7", method: "tools/list", params: {} }],
    ]);
    requests[0]?.answer({ result: { tools: [] } });
    await Bun.sleep(0);
    expect(received).toEqual([{ jsonrpc: "2.0", id: 7, result: { tools: [] } }]);
  });

  test("an error answer is the MCP request's error", async () => {
    const { client, requests } = fakeClient();
    const transport = acpMcpTransport(client, "srv_1");
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (m) => received.push(m);
    await transport.send({ jsonrpc: "2.0", id: "a", method: "tools/call", params: {} });
    requests[0]?.answer({ error: { code: -32602, message: "bad" } });
    await Bun.sleep(0);
    expect(received).toEqual([
      { jsonrpc: "2.0", id: "a", error: { code: -32602, message: "bad" } },
    ]);
  });

  test("a notification goes as an mcp/message notification", async () => {
    const { client, notifications } = fakeClient();
    await acpMcpTransport(client, "srv_1").send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(notifications).toEqual([
      {
        method: MCP_MESSAGE,
        params: { serverId: "srv_1", method: "notifications/initialized", params: undefined },
      },
    ]);
  });

  test("cancelling an MCP request cancels the mcp/message carrying it", async () => {
    const { client, requests, notifications } = fakeClient();
    const transport = acpMcpTransport(client, "srv_1");
    await transport.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {} });
    expect(requests[0]?.signal?.aborted).toBe(false);
    await transport.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 3 },
    });
    expect(requests[0]?.signal?.aborted).toBe(true);
    // The cancel rides ACP's own `$/cancel_request`, not a forwarded notification.
    expect(notifications).toEqual([]);
  });

  test("closing aborts every request in flight", async () => {
    const { client, requests } = fakeClient();
    const transport = acpMcpTransport(client, "srv_1");
    await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
    await transport.close();
    expect(requests[0]?.signal?.aborted).toBe(true);
  });
});
