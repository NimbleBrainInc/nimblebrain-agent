# nimblebrain-agent

An agent runtime that speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP v1).
Any ACP client can drive it: an editor, a CLI, or a host such as NimbleBrain that owns the
conversation and hands nimblebrain-agent one turn at a time.

nimblebrain-agent runs the agent loop: it calls the model, calls the tools of the MCP servers the
client names, keeps the turn's context inside the model's window, streams what it does, and stops
when told. It keeps no conversation store, no credentials beyond the model
key it is started with (or a session's own model credential), and no tools of its own.

## Run it

```bash
bun install
ANTHROPIC_API_KEY=… bun src/cli.ts acp      # ACP on stdio; logs go to stderr
bun src/cli.ts --version
```

Point an ACP client at that command. A session runs on these defaults:

| Variable | Meaning | Default |
|---|---|---|
| `NB_AGENT_MODEL` | `provider:model` (`anthropic:…`, `openai:…`) | `anthropic:claude-sonnet-4-6` |
| `NB_AGENT_SYSTEM_PROMPT` | The system prompt | a short general one |
| `NB_AGENT_MAX_ITERATIONS` | Loop iterations per turn (at most 50) | 25 |
| `NB_AGENT_MAX_INPUT_TOKENS` | Input-token cap per model call | 500000 |
| `NB_AGENT_MAX_OUTPUT_TOKENS` | Output-token cap per model call | the model's own limit |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | The provider key | none |
| `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` | Send model calls to a gateway instead | the provider's |

### As a worker

`nimblebrain-agent serve` runs it as a long-lived worker: ACP over Streamable HTTP at `/acp`, many
connections and sessions in one process, each connection with an agent of its own.

```bash
NB_AGENT_HOST=0.0.0.0 NB_AGENT_AUTH_JWKS_URL=http://runtime:27247/.well-known/run-keys.json \
  NB_AGENT_AUTH_ISSUER=https://runtime.example bun src/cli.ts serve
```

| Variable | Meaning | Default |
|---|---|---|
| `NB_AGENT_HOST`, `NB_AGENT_PORT` | Address to serve on | `127.0.0.1`, `8080` |
| `NB_AGENT_AUTH_JWKS_URL` | The runtime's public key set | required |
| `NB_AGENT_AUTH_ISSUER` | The issuer the runtime's credentials name | required |
| `NB_AGENT_AUTH=none` | No connection check; refused unless the host is loopback | |
| `NB_AGENT_DRAIN_MS` | Longest a drain waits for the turns in flight | 900000 |

- **Connection check.** Every request carries `Authorization: Bearer <credential>`, a JWS the
  runtime signs with its run key (EdDSA): issuer `NB_AGENT_AUTH_ISSUER`, audience `acp-worker`, in
  date. The worker verifies it against the key set, refetching it (at most every 30 seconds) for a
  key id it does not know, so a key rotation needs no restart. Anything else is a 401.
- **Probes.** `GET /healthz` answers while the process runs; `GET /readyz` answers 503 once it
  drains.
- **Drain.** On SIGTERM or SIGINT it refuses new connections and sessions, waits for the turns in
  flight (at most `NB_AGENT_DRAIN_MS`), then closes.

## What nimblebrain-agent does

- **Tools:** whatever the MCP servers named at `session/new` serve, and nothing else. A server is
  reached over HTTP, or over the ACP connection itself when the client declares it with the `acp`
  transport (`mcpCapabilities.acp`, the MCP-over-ACP proposal): each MCP message then travels as
  `mcp/message` on the connection, so the client opens nothing for the agent to call.
  nimblebrain-agent advertises no filesystem or terminal use, and has no built-in tools.
- **Context:** each model call's history is windowed to the call's budget, and a turn that
  outgrows it folds older history into a summary, written by the session's model unless the
  session names another or turns the fold off (`compaction`). The summary's usage is part of the
  turn's usage.
- **Streaming:** message text as `agent_message_chunk`, reasoning as `agent_thought_chunk`, and each
  tool call as `tool_call` / `tool_call_update`.
- **Cancellation:** `session/cancel` stops the turn, including a tool call in flight; the turn
  answers `cancelled`.
- **Multi-turn:** a session keeps its own history across prompts.

## Session options

A client that owns the conversation can hand nimblebrain-agent the turn's context on `session/new`. Every field
is optional; what is left out comes from the defaults above.

```jsonc
"_meta": {
  "nimblebrain-agent/session": {
    "system": "…",              // the system prompt
    "history": "…",             // prior messages, oldest first (below)
    "model": "anthropic:claude-sonnet-4-6",
    "maxIterations": 25,
    "maxInputTokens": 200000,
    "maxOutputTokens": 8192,
    "thinking": { "mode": "effort", "effort": "medium", "source": "config" },
    "compaction": { "model": "anthropic:claude-haiku-4-5" },  // or false: never fold
    "modelCredential": "…",     // a bearer the session's model calls present instead of the key
    "modelEndpoint": "https://…"  // where those calls go (a model gateway); only with modelCredential
  }
}
```

`modelCredential` is for a host whose model gateway issues a credential per turn: the session's
calls send it as `Authorization: Bearer` to `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`, in place of
the worker's provider key. It is held in memory for the session's life and never logged.
`modelEndpoint` sends those calls to that base URL instead of the worker's; it is refused without
`modelCredential`, so a client can never send the worker's own key to an address it chose.

`history` is a JSON array of [AI SDK](https://ai-sdk.dev) `LanguageModelV4Message`s, with a file
part's bytes written as `{ "__nb_agent_bytes": "<base64>" }`. The turn's own message is the
`session/prompt` content.

A `session/prompt` response carries in `_meta`:

- `"nimblebrain-agent/stopReason"`: nimblebrain-agent's own stop reason (for example
  `max_input_tokens`), finer than ACP's `stopReason`.
- `"nimblebrain-agent/usage"`: every model call of the turn in the order it finished, each as
  `{ model, purpose: "turn" | "summary", usage }`, and their `total`. `usage` is a
  `TokenUsage` (`src/usage/types.ts`), which keeps what ACP's `usage` drops: the 1-hour share of cache writes, and the
  per-call split that tiered prices are computed from.

## Embedding

`createAgent({ resolveModel, defaults })` (`src/acp/agent.ts`) returns an ACP agent app to
connect to any stream, or directly to an ACP client in the same process.

## Development

```bash
bun run check        # typecheck src and tests
bun run test         # unit and integration tests (no network, no key)
bun run lint
```

Changing it: `AGENTS.md`.

## License

Apache-2.0
