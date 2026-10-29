#!/usr/bin/env bun
/**
 * The `nimblebrain-agent` command.
 *
 *   nimblebrain-agent acp        Serve the Agent Client Protocol on stdio (stdout carries
 *                     the protocol; every log line goes to stderr).
 *   nimblebrain-agent serve      Serve it over Streamable HTTP as a long-lived worker
 *                     (`src/serve/http.ts`), until SIGTERM drains it.
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
 * OPENAI_BASE_URL to send calls through a gateway instead. A session that
 * brings its own model credential presents that instead of the key.
 *
 * `serve` reads:
 *
 *   NB_AGENT_HOST               address to bind       default 127.0.0.1
 *   NB_AGENT_PORT               port                   default 8080
 *   NB_AGENT_DRAIN_MS           longest drain wait     default 900000
 *   NB_AGENT_AUTH_JWKS_URL      the runtime's public key set, which connection credentials verify against
 *   NB_AGENT_AUTH_JWKS_FILE     or a file holding that key set (exactly one of the two)
 *   NB_AGENT_AUTH_ISSUER        the issuer those credentials name (the runtime's public origin)
 *   NB_AGENT_AUTH=none          no connection check; refused unless NB_AGENT_HOST is loopback
 */

import { existsSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { createAgent, AGENT_VERSION } from "./acp/agent.ts";
import { type ConnectionAuth, createConnectionAuth } from "./serve/connection-auth.ts";
import { serveHttp } from "./serve/http.ts";
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

const DEFAULT_PORT = 8080;
const DEFAULT_DRAIN_MS = 15 * 60_000;

/** The connection check `serve` runs, from the environment. */
export function connectionAuthFrom(env: Env): ConnectionAuth | null {
  if (env.NB_AGENT_AUTH === "none") return null;
  const jwksUrl = env.NB_AGENT_AUTH_JWKS_URL || undefined;
  const jwksFile = env.NB_AGENT_AUTH_JWKS_FILE || undefined;
  const issuer = env.NB_AGENT_AUTH_ISSUER;
  if (jwksUrl && jwksFile) {
    throw new Error(
      "serve takes one of NB_AGENT_AUTH_JWKS_URL and NB_AGENT_AUTH_JWKS_FILE, not both",
    );
  }
  if (!(jwksUrl || jwksFile) || !issuer) {
    throw new Error(
      "serve needs NB_AGENT_AUTH_JWKS_URL (or NB_AGENT_AUTH_JWKS_FILE) and NB_AGENT_AUTH_ISSUER (or NB_AGENT_AUTH=none on loopback)",
    );
  }
  // A file path is checked at start, so a wrong path fails the start rather than every request.
  if (jwksFile && !existsSync(jwksFile)) {
    throw new Error(`NB_AGENT_AUTH_JWKS_FILE ${jwksFile} does not exist`);
  }
  return createConnectionAuth({ jwksUrl, jwksFile, issuer });
}

/** Serve over HTTP until SIGTERM or SIGINT, then drain. */
export async function serveWorker(env: Env = process.env): Promise<void> {
  const worker = await serveHttp(
    { resolveModel: createModelResolver(env), defaults: defaultsFrom(env) },
    {
      hostname: env.NB_AGENT_HOST || "127.0.0.1",
      port: intFrom(env, "NB_AGENT_PORT") ?? DEFAULT_PORT,
      auth: connectionAuthFrom(env),
      drainMs: intFrom(env, "NB_AGENT_DRAIN_MS") ?? DEFAULT_DRAIN_MS,
    },
  );
  log.info(`[serve] nimblebrain-agent ${AGENT_VERSION} serving ACP at ${worker.url}`);
  await new Promise<void>((resolve) => {
    const drain = () => {
      log.info("[serve] draining");
      void worker.drain().then(resolve);
    };
    process.once("SIGTERM", drain);
    process.once("SIGINT", drain);
  });
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
  if (command === "serve") {
    await serveWorker();
    return 0;
  }
  process.stderr.write("usage: nimblebrain-agent acp | serve | --version\n");
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
