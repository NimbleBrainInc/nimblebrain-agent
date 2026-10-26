/**
 * A stand-in for Anthropic's Messages API, streaming in its real wire format,
 * so a test drives nimblebrain-agent's actual provider SDK through `ANTHROPIC_BASE_URL`
 * with no network and no key.
 *
 * It answers like a minimal agent: with tools offered and no tool result yet,
 * it calls the first tool with `{"orderId":"8812"}`; otherwise it replies in
 * text, echoing the last tool result when there is one.
 */

interface MessagesRequest {
  tools?: { name: string }[];
  system?: unknown;
  messages: {
    role: string;
    content: string | { type: string; content?: unknown; text?: string }[];
  }[];
}

export interface FakeAnthropic {
  baseUrl: string;
  requests: MessagesRequest[];
  close(): Promise<void>;
}

export function startFakeAnthropic(): FakeAnthropic {
  const requests: MessagesRequest[] = [];
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/messages"))
        return new Response(null, { status: 404 });
      const body = (await req.json()) as MessagesRequest;
      requests.push(body);
      return new Response(stream(reply(body)), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${http.port}/v1`,
    requests,
    close: async () => {
      await http.stop(true);
    },
  };
}

type Reply = { kind: "text"; text: string } | { kind: "tool"; name: string; input: string };

function reply(body: MessagesRequest): Reply {
  const last = body.messages.at(-1);
  const parts = Array.isArray(last?.content) ? last.content : [];
  const result = parts.find((p) => p.type === "tool_result");
  if (result) {
    const content = result.content;
    const text = Array.isArray(content)
      ? content.map((c: { text?: string }) => c.text ?? "").join("")
      : String(content ?? "");
    return { kind: "text", text: `The tool says: ${text}` };
  }
  const tool = body.tools?.[0];
  if (tool) return { kind: "tool", name: tool.name, input: '{"orderId":"8812"}' };
  return { kind: "text", text: "Hello from the fake model." };
}

function stream(r: Reply): ReadableStream<Uint8Array> {
  const events: [string, unknown][] = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_fake",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 12, output_tokens: 0 },
        },
      },
    ],
  ];
  if (r.kind === "text") {
    events.push(
      [
        "content_block_start",
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      ],
      [
        "content_block_delta",
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: r.text } },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
      ],
    );
  } else {
    events.push(
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_fake", name: r.name, input: {} },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: r.input },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
      ],
    );
  }
  events.push(["message_stop", { type: "message_stop" }]);
  const text = events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(text).body as ReadableStream<Uint8Array>;
}
