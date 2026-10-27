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

/** The stub's MCP server: one `lookup_order` tool, answered by `answer`, its calls kept in `calls`. */
export function stubMcpServer(
  answer: (input: Record<string, unknown>) => string | Promise<string>,
  calls: Record<string, unknown>[],
): Server {
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
  server.setRequestHandler("tools/call", async (request) => {
    const input = (request.params.arguments ?? {}) as Record<string, unknown>;
    calls.push(input);
    return { content: [{ type: "text", text: await answer(input) }], isError: false };
  });
  return server;
}

export function startStubMcp(answer: (input: Record<string, unknown>) => string): StubMcp {
  const calls: Record<string, unknown>[] = [];
  const handler = createMcpHandler(() => stubMcpServer(answer, calls), { legacy: "reject" });
  const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => handler.fetch(req) });
  return {
    url: `http://127.0.0.1:${http.port}/mcp`,
    calls,
    close: async () => {
      await http.stop(true);
    },
  };
}
