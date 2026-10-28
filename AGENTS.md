# nimblebrain-agent

An ACP agent runtime: an agent loop served over the Agent Client Protocol. `README.md` covers
running and embedding it. This file covers changing it.

## Build & verify

```bash
bun install
bun run check && bun run test && bun run lint
```

Every `bun` in the test path passes `--no-env-file`, so a developer's real keys never reach a test.

CI (`.github/workflows/ci.yml`) runs the same checks on every change.

## Layout

- `src/acp/`: the agent, its session options, the MCP tool router and its MCP-over-ACP transport.
- `src/serve/`: the network worker (`serve`): ACP over Streamable HTTP, the connection check, drain.
- `src/engine/`: the loop. `src/engine/schemas/events.ts` holds the engine's event payloads, one
  schema per event type.
- `src/model/`: the model layer; `resolve.ts` turns a `provider:model` string into a language model.
- `src/context/hooks.ts`, `src/conversation/`, `src/runtime/`: context management wired into the
  loop (windowing, compaction, and the budget helpers).
- `src/cli.ts`: the entry point: `acp` on stdio, `serve` over HTTP.

## Rules

- **nimblebrain-agent depends on nothing of a host.** No conversation store, no workspace, identity, permission
  or credential store, no platform tool. A host's state reaches nimblebrain-agent as session options or as MCP
  servers named at `session/new`, and nothing else.
- **stdout is the protocol.** Every log line goes to stderr (`src/observability/log.ts` already does).
  Never write to stdout outside the ACP stream.
- **A credential is never logged or stored.** A session's `modelCredential` and the bearer on a
  worker's requests live in memory for as long as they are used; a refusal logs its reason, never
  the credential.
- **Session options are a documented contract** (`README.md`, `src/acp/session-options.ts`). A
  change is a change for every client: add fields, never repurpose one.
- **No tools of nimblebrain-agent's own.** Tools come from the client's MCP servers, so a host decides what an
  agent may reach.
