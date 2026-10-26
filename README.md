# nimblebrain-agent

An agent runtime that speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP v1).
Any ACP client can drive it: an editor, a CLI, or a host such as NimbleBrain that owns the
conversation and hands nimblebrain-agent one turn at a time.

nimblebrain-agent is NimbleBrain's agent loop, extracted. It runs the loop, calls the model, calls the tools
of the MCP servers the client names, keeps the turn's context inside the model's window, streams
what it does, and stops when told. It keeps no conversation store, no credentials beyond the model
key it is started with, and no tools of its own.

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

## What nimblebrain-agent does

- **Tools:** whatever the HTTP MCP servers named at `session/new` serve, and nothing else. nimblebrain-agent
  advertises no filesystem or terminal use, and has no built-in tools.
- **Context:** each model call's history is windowed to the call's budget, and a turn that
  outgrows it folds older history into a summary written by the session's model. The summary's
  usage is part of the turn's usage.
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
    "thinking": { "mode": "effort", "effort": "medium", "source": "config" }
  }
}
```

`history` is a JSON array of [AI SDK](https://ai-sdk.dev) `LanguageModelV4Message`s, with a file
part's bytes written as `{ "__nb_agent_bytes": "<base64>" }`. The turn's own message is the
`session/prompt` content.

A `session/prompt` response carries nimblebrain-agent's own stop reason in `_meta["nimblebrain-agent/stopReason"]`
(for example `max_input_tokens`), finer than ACP's `stopReason`.

## Embedding

`createAgent({ resolveModel, defaults })` (`src/acp/agent.ts`) returns an ACP agent app to
connect to any stream, or directly to an ACP client in the same process.

## Development

```bash
bun run check        # typecheck src and tests
bun run test         # unit and integration tests (no network, no key)
bun run lint
bun run sync:check <nimblebrain checkout>   # is the engine in step with NimbleBrain's?
```

The engine is carried from NimbleBrain verbatim (`mirror.txt`); see `AGENTS.md`.

## License

Apache-2.0
