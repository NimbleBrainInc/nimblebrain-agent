/**
 * The stub MCP server served over the ACP connection, as a client that
 * declares an `acp` MCP server does: each `mcp/message` from the agent for the
 * declared id is fed to the server on an in-memory link, and answered with the
 * server's response to it.
 */

import * as acp from "@agentclientprotocol/sdk/unstable";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { MCP_MESSAGE } from "../../src/acp/acp-mcp-transport.ts";
import { stubMcpServer } from "./stub-mcp.ts";

type Answer = { result: unknown } | { error: { code: number; message: string; data?: unknown } };

interface McpMessage {
  serverId: string;
  requestId?: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface AcpStubMcp {
  /** The declared server, for `session/new`. */
  server: acp.McpServer;
  calls: Record<string, unknown>[];
  /** Request ids the agent cancelled. */
  cancelled: string[];
  /** Register the `mcp/message` handlers on the test's client app. */
  serve(app: acp.ClientApp): acp.ClientApp;
}

export function acpStubMcp(answer: (input: Record<string, unknown>) => string): AcpStubMcp {
  const calls: Record<string, unknown>[] = [];
  const cancelled: string[] = [];
  const serverId = `stub_${crypto.randomUUID()}`;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const pending = new Map<string, (answer: Answer) => void>();
  clientSide.onmessage = (message) => {
    if (!("id" in message) || !("result" in message || "error" in message)) return;
    const settle = pending.get(String(message.id));
    pending.delete(String(message.id));
    settle?.("error" in message ? { error: message.error } : { result: message.result });
  };
  const server = stubMcpServer(answer, calls);
  const ready = server.connect(serverSide);
  const parse = (raw: unknown) => raw as McpMessage;
  return {
    server: { type: "acp", name: "stub", serverId },
    calls,
    cancelled,
    serve(app) {
      return app
        .onRequest(MCP_MESSAGE, parse, async (ctx) => {
          const { requestId, method, params } = ctx.params;
          if (ctx.params.serverId !== serverId || !requestId) {
            throw acp.RequestError.invalidParams(undefined, "unknown MCP server");
          }
          await ready;
          const answered = new Promise<Answer>((resolve) => pending.set(requestId, resolve));
          ctx.signal.addEventListener("abort", () => {
            cancelled.push(requestId);
            pending.get(requestId)?.({ error: { code: -32800, message: "request cancelled" } });
            pending.delete(requestId);
          });
          await clientSide.send({
            jsonrpc: "2.0",
            id: requestId,
            method,
            ...(params ? { params } : {}),
          });
          return answered;
        })
        .onNotification(MCP_MESSAGE, parse, async (ctx) => {
          if (ctx.params.serverId !== serverId) return;
          await ready;
          const { method, params } = ctx.params;
          await clientSide.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
        });
    },
  };
}
