#!/usr/bin/env bun
/**
 * The `nimblebrain-agent` command.
 *
 *   nimblebrain-agent acp        Serve the Agent Client Protocol on stdio (stdout carries
 *                     the protocol; every log line goes to stderr).
 *   nimblebrain-agent --version
 *
 * A session's defaults come from the environment, and a client's session
 * options override them (`src/acp/session-options.ts`):
 *
 *   NB_AGENT_MODEL              provider:model         default anthropic:claude-sonnet-4-6
 *   NB_AGENT_SYSTEM_PROMPT      the system prompt      default: a short general one
 *   NB_AGENT_MAX_ITERATIONS     loop iterations        default 25 (at most 50)
 *   NB_AGENT_MAX_INPUT_TOKENS   per-call input cap     default 500000
 *   NB_AGENT_MAX_OUTPUT_TOKENS  per-call output cap    default: the model's own limit
 *
 * Model keys: ANTHROPIC_API_KEY / OPENAI_API_KEY, with ANTHROPIC_BASE_URL /
 * OPENAI_BASE_URL to send calls through a gateway instead.
 */

import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { createAgent, AGENT_VERSION } from "./acp/agent.ts";
import type { SessionSettings } from "./acp/session-options.ts";
import { DEFAULT_MAX_INPUT_TOKENS, DEFAULT_MAX_ITERATIONS, MAX_ITERATIONS } from "./limits.ts";
import { createModelResolver } from "./model/resolve.ts";
import { log } from "./observability/log.ts";
import { resolveMaxOutputTokens } from "./runtime/resolve-max-output-tokens.ts";

const DEFAULT_MODEL = "anthropic:claude-sonnet-4-6";
const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful agent. Use the tools you are given to find real answers rather than guessing, and say plainly when you cannot do something.";

type Env = Record<string, string | undefined>;

/** A session's defaults, from the environment. */
export function defaultsFrom(env: Env): SessionSettings {
  const model = env.NB_AGENT_MODEL || DEFAULT_MODEL;
  return {
    model,
    system: env.NB_AGENT_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
    maxIterations: Math.min(
      intFrom(env, "NB_AGENT_MAX_ITERATIONS") ?? DEFAULT_MAX_ITERATIONS,
      MAX_ITERATIONS,
    ),
    maxInputTokens: intFrom(env, "NB_AGENT_MAX_INPUT_TOKENS") ?? DEFAULT_MAX_INPUT_TOKENS,
    maxOutputTokens: resolveMaxOutputTokens({
      configValue: intFrom(env, "NB_AGENT_MAX_OUTPUT_TOKENS"),
      model,
    }),
  };
}

function intFrom(env: Env, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

/** Serve ACP on this process's stdio until the client disconnects. */
export async function serveAcp(env: Env = process.env): Promise<void> {
  const agent = createAgent({
    resolveModel: createModelResolver(env),
    defaults: defaultsFrom(env),
  });
  const connection = agent.connect(
    acp.ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    ),
  );
  await connection.closed;
}

async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  if (command === "--version" || command === "-v") {
    process.stdout.write(`nimblebrain-agent ${AGENT_VERSION}\n`);
    return 0;
  }
  if (command === "acp") {
    await serveAcp();
    return 0;
  }
  process.stderr.write("usage: nimblebrain-agent acp | nimblebrain-agent --version\n");
  return command === undefined || command === "--help" || command === "-h" ? 0 : 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      log.error(`nimblebrain-agent: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
