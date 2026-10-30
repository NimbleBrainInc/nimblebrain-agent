/**
 * Reading a model call's failure, whichever SDK threw it.
 *
 * The engine calls `model.doStream()`, so a provider failure arrives as the AI
 * SDK's `APICallError`, which carries the HTTP status in `statusCode` and the
 * response body in `responseBody`. Other errors (a vendor SDK, a test double)
 * carry the status in `status`. Both are read here so every classifier sees the
 * same number.
 */

/** The failure's HTTP status: a vendor SDK's `status`, else the AI SDK's `statusCode`. */
export function providerStatus(err: unknown): number | undefined {
  if (err === null || typeof err !== "object") return undefined;
  const { status, statusCode } = err as { status?: unknown; statusCode?: unknown };
  if (typeof status === "number") return status;
  if (typeof statusCode === "number") return statusCode;
  return undefined;
}

/** The body of a model gateway's answer to a call past the run's model budget. */
const BUDGET_REFUSAL_BODY = "rate limit exceeded";

const TOO_MANY_REQUESTS = 429;

/**
 * Whether `err` is a model gateway's refusal of a call because the run's model
 * budget is spent: 429 with the body `rate limit exceeded` (`text/plain`). No
 * provider answers in that form (a provider's 429 is its own JSON error, which
 * a gateway passes through), and a retry cannot clear it, since the budget does
 * not refill within a run. The AI SDK marks it `isRetryable` like any other
 * 429, so the retry policy reads this first.
 *
 * The agent does not end the run on it: the turn fails with the call's status
 * and body (`src/acp/model-error.ts`), and the host, which knows whether its
 * endpoint is a gateway, decides what the refusal means.
 */
export function isGatewayBudgetRefusal(err: unknown): boolean {
  if (providerStatus(err) !== TOO_MANY_REQUESTS) return false;
  const { responseBody } = err as { responseBody?: unknown };
  return typeof responseBody === "string" && responseBody.trim() === BUDGET_REFUSAL_BODY;
}
