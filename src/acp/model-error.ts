/**
 * A turn that failed on a model call, as the ACP error its client reads.
 *
 * The error carries what the provider answered, so a client can tell a refusal
 * it understands (a spent budget, a provider's rate limit) from a crash: the
 * call's HTTP status and the provider's own words, and the turn's usage until
 * then, since the calls before the failed one were made and billed. A provider's
 * text can echo the request's credential, so every credential the agent holds
 * is cut from it before it leaves.
 */

import * as acp from "@agentclientprotocol/sdk/unstable";
import type { ModelAccess } from "../model/resolve.ts";
import { MODEL_ERROR_KEY, type TurnUsage, USAGE_META_KEY } from "./session-options.ts";

/** The most of the provider's text the error carries. */
const MAX_REASON_CHARS = 500;

/** Environment variables whose values are the agent's model keys: cut at any length. */
const API_KEY_VAR = /_API_KEY$/i;

/** Environment variables whose names suggest a credential. */
const SECRET_VAR = /KEY|TOKEN|SECRET|PASSWORD/i;

/**
 * The shortest value cut for a name that only suggests a credential: such a
 * name also matches settings (`TOKENIZERS_PARALLELISM=false`), and cutting
 * their short values would mangle the text.
 */
const MIN_GUESSED_SECRET_CHARS = 8;

/** What a failed model call reported: its HTTP status and the provider's reason. */
export interface ModelCallFailure {
  status: number;
  reason?: string;
}

/**
 * The ACP error for a turn that failed on a model call, or `undefined` when the
 * error is not one (it carries no HTTP status). Its code stays JSON-RPC's
 * internal error, so a client that reads only the code sees what it saw before.
 */
export function modelCallError(
  err: unknown,
  usage: TurnUsage,
  credentials: readonly string[],
): acp.RequestError | undefined {
  const status = statusOf(err);
  if (status === undefined) return undefined;
  const reason = reasonOf(err, credentials);
  const failure: ModelCallFailure = { status, ...(reason ? { reason } : {}) };
  return acp.RequestError.internalError(
    { [MODEL_ERROR_KEY]: failure, [USAGE_META_KEY]: usage },
    `model call failed with status ${status}${reason ? `: ${reason}` : ""}`,
  );
}

/**
 * Every credential the agent holds for a session's model calls: the headers of
 * the client's provider routes (a bearer's token on its own too) and the
 * process's model keys, at any length, and the values of other variables named
 * like a credential.
 */
export function credentialsOf(
  access: ModelAccess | undefined,
  env: Record<string, string | undefined>,
): string[] {
  const values: string[] = [];
  for (const route of Object.values(access?.providers ?? {})) {
    for (const value of Object.values(route?.headers ?? {})) {
      values.push(value, value.replace(/^Bearer\s+/i, ""));
    }
  }
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (API_KEY_VAR.test(name)) values.push(value);
    else if (SECRET_VAR.test(name) && value.length >= MIN_GUESSED_SECRET_CHARS) values.push(value);
  }
  return [...new Set(values)].filter((v) => v.trim() !== "");
}

/** The call's HTTP status: the AI SDK's `statusCode`, or a vendor SDK's `status`. */
function statusOf(err: unknown): number | undefined {
  const { status, statusCode } = (err ?? {}) as { status?: unknown; statusCode?: unknown };
  const code = typeof status === "number" ? status : statusCode;
  return typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599
    ? code
    : undefined;
}

/**
 * The provider's reason: the body it answered with (its own words, which the
 * AI SDK's message replaces with the status text when the body is not JSON),
 * else the error's message, with every credential cut and the length capped.
 */
function reasonOf(err: unknown, credentials: readonly string[]): string | undefined {
  const { responseBody, message } = (err ?? {}) as { responseBody?: unknown; message?: unknown };
  const raw =
    typeof responseBody === "string" && responseBody.trim() !== ""
      ? responseBody
      : typeof message === "string"
        ? message
        : "";
  let text = raw.trim();
  // Longest first, so a token is never left half-cut by its own prefix.
  for (const secret of [...credentials].sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("[redacted]");
  }
  if (text.length > MAX_REASON_CHARS) text = `${text.slice(0, MAX_REASON_CHARS)}…`;
  return text || undefined;
}
