/**
 * nimblebrain-agent as a long-lived worker: ACP over Streamable HTTP, many
 * connections and sessions in one process.
 *
 * Routes:
 *   POST/GET/DELETE /acp   the ACP transport, behind the connection check
 *   GET /healthz           the process is up (a liveness probe)
 *   GET /readyz            the process takes new sessions (a readiness probe; 503 while draining)
 *
 * Each accepted connection gets an agent of its own, so a connection that
 * closes ends only its own sessions. Draining stops new connections and new
 * sessions, waits for the turns in flight up to a limit, then closes.
 *
 * Served by `node:http` through the SDK's Node adapter: a session's SSE stream
 * must deliver its first event at once, and `Bun.serve` with the Web-standard
 * handler holds it back, so the client never sends the turn's prompt.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createNodeHttpHandler } from "@agentclientprotocol/sdk/experimental/node";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { type AgentOptions, createAgent } from "../acp/agent.ts";
import { log } from "../observability/log.ts";
import { type ConnectionAuth, ConnectionRefused } from "./connection-auth.ts";

export const ACP_PATH = "/acp";

/**
 * How long a drain keeps connections open after the last turn ends. A turn
 * ends in the agent before its last messages (the prompt's response, the final
 * updates) are written to the client, so closing at once could drop them.
 */
const FLUSH_GRACE_MS = 1_000;

/** The header the ACP transport names an open connection by. */
const CONNECTION_ID_HEADER = "acp-connection-id";

export interface ServeOptions {
  hostname: string;
  port: number;
  /** Who may connect; `null` only on loopback, for a developer's own machine. */
  auth: ConnectionAuth | null;
  /** The longest a drain waits for the turns in flight. */
  drainMs: number;
}

export interface Worker {
  /** Where the ACP transport is served. */
  url: string;
  /** Refuse new connections and sessions, wait for the turns in flight, then close. */
  drain(): Promise<void>;
  /** Close at once. */
  stop(): Promise<void>;
}

export async function serveHttp(
  agent: Omit<AgentOptions, "lifecycle">,
  opts: ServeOptions,
): Promise<Worker> {
  if (!opts.auth && !isLoopback(opts.hostname)) {
    throw new Error(
      `refusing to serve on ${opts.hostname} without a connection check: only loopback may run without one`,
    );
  }
  let draining = false;
  let turns = 0;
  let turnsDone: (() => void) | null = null;
  const lifecycle = {
    admit: () => !draining,
    turnStarted: () => {
      turns++;
    },
    turnEnded: () => {
      turns--;
      if (turns === 0) turnsDone?.();
    },
  };
  const acpServer = new AcpServer({ createAgent: () => createAgent({ ...agent, lifecycle }) });

  const acpHandler = createNodeHttpHandler(acpServer);

  const respond = (res: ServerResponse, status: number, body?: string) => {
    res.writeHead(status, body ? { "content-type": "text/plain" } : {});
    res.end(body);
  };
  /** Whether the request may reach the ACP transport; answers it when not. */
  const admitted = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (opts.auth) {
      try {
        await opts.auth.check(req.headers.authorization ?? null);
      } catch (err) {
        if (!(err instanceof ConnectionRefused)) throw err;
        log.warn(`[serve] connection refused: ${err.message}`);
        respond(res, 401);
        return false;
      }
    }
    if (draining && req.headers[CONNECTION_ID_HEADER] === undefined) {
      respond(res, 503, "draining");
      return false;
    }
    return true;
  };

  const route = async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://worker").pathname;
    if (pathname === "/healthz") return respond(res, 200, "ok");
    if (pathname === "/readyz") {
      return draining ? respond(res, 503, "draining") : respond(res, 200, "ok");
    }
    if (pathname !== ACP_PATH) return respond(res, 404);
    if (await admitted(req, res)) acpHandler(req, res);
  };

  const http = createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      log.error(`[serve] request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) respond(res, 500);
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, opts.hostname, () => resolve());
  });
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : opts.port;

  const stop = async () => {
    await acpServer.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  };

  return {
    url: `http://${opts.hostname.includes(":") ? `[${opts.hostname}]` : opts.hostname}:${port}${ACP_PATH}`,
    async drain() {
      draining = true;
      const inFlight = turns > 0;
      if (inFlight) {
        await Promise.race([
          new Promise<void>((resolve) => {
            turnsDone = resolve;
          }),
          Bun.sleep(opts.drainMs),
        ]);
      }
      if (turns > 0) log.warn(`[serve] drain limit reached with ${turns} turn(s) in flight`);
      else if (inFlight) await Bun.sleep(FLUSH_GRACE_MS);
      await stop();
    },
    stop,
  };
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
}
