# nimblebrain-agent

An ACP agent runtime: NimbleBrain's agent loop, extracted. `README.md` covers running and
embedding it. This file covers changing it.

## Build & verify

```bash
bun install
bun run check && bun run test && bun run lint
bun run sync:check <nimblebrain checkout>
```

Every `bun` in the test path passes `--no-env-file`, so a developer's real keys never reach a test.

CI (`.github/workflows/ci.yml`) runs the same checks, and `sync:check` against NimbleBrain's `main`
on every change and daily. A red sync job means NimbleBrain changed a mirrored file: run
`bun run sync <checkout>` and land the copy here.

## Two kinds of code

- **Mirrored from NimbleBrain** (every path in `mirror.txt`): the engine (`src/engine/`), the model
  layer it uses (`src/model/` except `resolve.ts`), windowing and compaction
  (`src/conversation/window.ts`, `compaction.ts`, `src/runtime/mid-turn-compaction.ts`), the budget
  helpers in `src/runtime/`, and their tests. They sit at the same path as in NimbleBrain and stay
  byte-identical to it. Change them in NimbleBrain, then `bun run sync <checkout>`. Never edit one
  here: the next sync overwrites it, and `sync:check` fails on the drift until then.
- **nimblebrain-agent's own**: `src/acp/` (the agent, its session options, the MCP tool router),
  `src/context/hooks.ts` (context management wired into the loop), `src/model/resolve.ts`,
  `src/cli.ts`, and `src/conversation/types.ts`. `src/engine/schemas/events.ts` is generated: the
  engine's own events, trimmed from NimbleBrain's catalog by `scripts/trim-events.py`.

## Rules

- **nimblebrain-agent depends on nothing of a host.** No conversation store, no workspace, identity, permission
  or credential store, no platform tool. A host's state reaches nimblebrain-agent as session options or as MCP
  servers named at `session/new`, and nothing else.
- **stdout is the protocol.** Every log line goes to stderr (`src/observability/log.ts` already does).
  Never write to stdout outside the ACP stream.
- **Session options are a documented contract** (`README.md`, `src/acp/session-options.ts`). A
  change is a change for every client: add fields, never repurpose one.
- **No tools of nimblebrain-agent's own.** Tools come from the client's MCP servers, so a host decides what an
  agent may reach.
- **Behaviour matches NimbleBrain's native engine.** A host runs the same runs on both and compares
  the records (NimbleBrain's `test/eval/runtime-parity.eval.test.ts`). An agent-only change to the
  loop's behaviour belongs in NimbleBrain's engine first.
