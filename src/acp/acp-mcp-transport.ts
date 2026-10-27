/**
 * MCP over the ACP connection (the MCP-over-ACP proposal), the agent's side.
 *
 * A client may declare an MCP server with the `acp` transport instead of a URL.
 * The agent then reaches it on the connection the client already holds: each
 * MCP request goes to the client as an `mcp/message` request for the declared
 * server id, and its answer is that request's response; an MCP notification
 * goes as an `mcp/message` notification. Cancelling an MCP request
 * (`notifications/cancelled`) cancels the `mcp/message` carrying it, which ACP
 * sends as `$/cancel_request`. Nothing is opened on either side.
 */

import type * as acp from "@agentclientprotocol/sdk/unstable";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";

/** The ACP method that carries one MCP message. */
export const MCP_MESSAGE = "mcp/message";

/** What the client answers an `mcp/message` request with. */
type McpAnswer =
  | { result: Record<string, unknown> }
  | { error: { code: number; message: string; data?: unknown } };

export function acpMcpTransport(client: acp.AgentContext, serverId: string): Transport {
  const inFlight = new Map<string, AbortController>();
  const transport: Transport = {
    async start() {},
    async close() {
      for (const controller of inFlight.values()) controller.abort();
      inFlight.clear();
      transport.onclose?.();
    },
    async send(message: JSONRPCMessage) {
      // A response to a request the server sent: the client's server asks the agent nothing.
      if (!("method" in message)) return;
      const params = "params" in message ? message.params : undefined;
      if (!("id" in message)) {
        if (message.method === "notifications/cancelled") {
          const requestId = (params as { requestId?: unknown } | undefined)?.requestId;
          inFlight.get(String(requestId))?.abort();
          return;
        }
        await client.notify(MCP_MESSAGE, { serverId, method: message.method, params });
        return;
      }
      const { id } = message;
      const requestId = String(id);
      const controller = new AbortController();
      inFlight.set(requestId, controller);
      // Answered asynchronously: the MCP client matches the response to its request by id.
      void client
        .request<McpAnswer>(
          MCP_MESSAGE,
          { serverId, requestId, method: message.method, params },
          { cancellationSignal: controller.signal },
        )
        .then((answer) =>
          transport.onmessage?.(
            "error" in answer
              ? { jsonrpc: "2.0", id, error: answer.error }
              : { jsonrpc: "2.0", id, result: answer.result },
          ),
        )
        .catch((err: unknown) =>
          transport.onmessage?.({
            jsonrpc: "2.0",
            id,
            error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          }),
        )
        .finally(() => inFlight.delete(requestId));
    },
  };
  return transport;
}
