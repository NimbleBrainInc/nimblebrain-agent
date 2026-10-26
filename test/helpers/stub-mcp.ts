/**
 * A one-tool MCP server on loopback, standing in for whatever a client hands
 * nimblebrain-agent at `session/new`.
 */

import { createMcpHandler, Server } from "@modelcontextprotocol/server";

export interface StubMcp {
  url: string;
  calls: Record<string, unknown>[];
  close(): Promise<void>;
}

export function startStubMcp(answer: (input: Record<string, unknown>) => string): StubMcp {
  const calls: Record<string, unknown>[] = [];
  const handler = createMcpHandler(
    () => {
      const server = new Server({ name: "stub", version: "1" }, { capabilities: { tools: {} } });
      server.setRequestHandler("tools/list", () => ({
        tools: [
          {
            name: "lookup_order",
            description: "Look up an order's status by id",
            inputSchema: {
              type: "object",
              properties: { orderId: { type: "string" } },
              required: ["orderId"],
            },
          },
        ],
      }));
      server.setRequestHandler("tools/call", (request) => {
        const input = (request.params.arguments ?? {}) as Record<string, unknown>;
        calls.push(input);
        return { content: [{ type: "text", text: answer(input) }], isError: false };
      });
      return server;
    },
    { legacy: "reject" },
  );
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => handler.fetch(req) });
  return {
    url: `http://127.0.0.1:${http.port}/mcp`,
    calls,
    close: async () => {
      await http.stop(true);
    },
  };
}
