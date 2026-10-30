import { describe, expect, it, spyOn } from "bun:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { APICallError } from "@ai-sdk/provider";
import { isRetryable, withRetry } from "../../src/engine/retry.ts";
import { ModelStreamStallError } from "../../src/model/stream.ts";

/** Helper: create an error with an HTTP status code. */
function httpError(status: number, message = `HTTP ${status}`): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

describe("isRetryable", () => {
  it("returns true for 429", () => {
    expect(isRetryable(httpError(429))).toBe(true);
  });

  it("returns true for 529", () => {
    expect(isRetryable(httpError(529))).toBe(true);
  });

  it("returns false for 401", () => {
    expect(isRetryable(httpError(401))).toBe(false);
  });

  it("returns true for a transient 5xx and 408", () => {
    for (const status of [408, 500, 502, 503, 504])
      expect(isRetryable(httpError(status))).toBe(true);
  });

  it("returns false for 400 and 404", () => {
    expect(isRetryable(httpError(400))).toBe(false);
    expect(isRetryable(httpError(404))).toBe(false);
  });

  it("returns false for plain Error (no status)", () => {
    expect(isRetryable(new Error("network timeout"))).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns immediately on success (no retry)", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries on 429 and succeeds on 3rd attempt", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw httpError(429);
        return "recovered";
      },
      3,
      0, // zero base delay for fast tests
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(3);
  });

  it("retries on 429 and throws after all retries exhausted", async () => {
    let calls = 0;
    const original = httpError(429, "rate limited");
    await expect(
      withRetry(
        async () => {
          calls++;
          throw original;
        },
        3,
        0,
      ),
    ).rejects.toThrow(original);
    // 1 initial + 3 retries = 4 calls
    expect(calls).toBe(4);
  });

  it("retries on 529 (same as 429)", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 2) throw httpError(529);
        return "ok";
      },
      3,
      0,
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("fails immediately on 401, rethrowing the error unchanged", async () => {
    let calls = 0;
    const unauthorized = httpError(401);
    await expect(
      withRetry(
        async () => {
          calls++;
          throw unauthorized;
        },
        3,
        0,
      ),
    ).rejects.toBe(unauthorized);
    expect(calls).toBe(1);
  });

  it("fails immediately on non-HTTP error (no retry)", async () => {
    let calls = 0;
    const err = new Error("ECONNRESET");
    await expect(
      withRetry(
        async () => {
          calls++;
          throw err;
        },
        3,
        0,
      ),
    ).rejects.toThrow(err);
    expect(calls).toBe(1);
  });

  it("interrupts backoff when signal aborts mid-sleep", async () => {
    // Pre-existing gap closed: if the signal aborted during the
    // backoff window, the engine had to wait the full delay (up to
    // ~8.5s on attempt 3) before the next retry attempt observed
    // the abort. Now the sleep is abort-aware — cancellation bites
    // within the abort tick.
    const controller = new AbortController();
    let calls = 0;
    const err = { status: 429 };
    const start = Date.now();

    const runPromise = withRetry(
      async () => {
        calls++;
        throw err;
      },
      3,
      // 5-second base delay — without the abort, attempt 1's
      // backoff alone would block this test for 5s+.
      5_000,
      controller.signal,
    );

    // Let attempt 1 fail and the backoff timer arm.
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();

    await expect(runPromise).rejects.toMatchObject({ name: "AbortError" });

    const elapsed = Date.now() - start;
    // Way under the 5-second backoff that would have held us
    // without the abort. A generous ceiling that still catches
    // any regression to "wait the full delay first".
    expect(elapsed).toBeLessThan(500);
    // Exactly one attempt fired before the abort interrupted backoff.
    expect(calls).toBe(1);
  });

  it("rejects synchronously when called with a pre-aborted signal during backoff", async () => {
    // Symmetric coverage: a signal that's already aborted when the
    // backoff sleep starts must reject immediately, not arm a timer
    // it then has to clean up. Matters for the engine's iteration
    // path where the abort may have fired during the prior attempt.
    const controller = new AbortController();
    let calls = 0;
    const err = { status: 429 };

    const fn = async () => {
      calls++;
      // Abort BEFORE we throw — backoff observes a pre-aborted
      // signal when it tries to sleep.
      if (calls === 1) controller.abort();
      throw err;
    };

    const start = Date.now();
    await expect(withRetry(fn, 3, 5_000, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(Date.now() - start).toBeLessThan(100);
    expect(calls).toBe(1);
  });
});

describe("isRetryable — retryable marker", () => {
  it("returns true for an error flagged retryable === true", () => {
    expect(isRetryable({ retryable: true })).toBe(true);
    expect(isRetryable(Object.assign(new Error("stalled"), { retryable: true }))).toBe(true);
  });

  it("returns false for retryable:false or a non-true marker", () => {
    expect(isRetryable({ retryable: false })).toBe(false);
    expect(isRetryable({ retryable: "yes" })).toBe(false);
  });
});

describe("withRetry — retryable marker", () => {
  it("retries an error flagged retryable and then succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 2) throw Object.assign(new Error("stalled"), { retryable: true });
        return "recovered";
      },
      3,
      0,
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(2);
  });
});

describe("withRetry logging", () => {
  /** Capture the logger's output channel (log.warn writes to console.error). */
  function captureWarnings(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    return { lines, restore: () => spy.mockRestore() };
  }

  it("logs nothing when the call succeeds on the first attempt", async () => {
    const { lines, restore } = captureWarnings();
    try {
      await withRetry(async () => "ok", 3, 0);
    } finally {
      restore();
    }
    expect(lines.filter((l) => l.includes("[engine] retry"))).toHaveLength(0);
  });

  it("logs one line per retried attempt, with attempt, reason and backoff", async () => {
    const { lines, restore } = captureWarnings();
    let calls = 0;
    try {
      await withRetry(
        async () => {
          calls++;
          if (calls < 3) throw httpError(429);
          return "recovered";
        },
        3,
        0,
      );
    } finally {
      restore();
    }
    const retries = lines.filter((l) => l.includes("[engine] retry"));
    // Two failures before the third attempt succeeded.
    expect(retries).toHaveLength(2);
    expect(retries[0]).toContain("attempt=1/3");
    expect(retries[0]).toContain("reason=429");
    expect(retries[0]).toMatch(/delayMs=\d+/);
    expect(retries[1]).toContain("attempt=2/3");
  });

  // Uses the real ModelStreamStallError, not a local stand-in. A stand-in has to
  // restate the name this asserts, which makes the assertion vacuous: drop
  // `this.name` from the real class and production logs `reason=Error` while the
  // test stays green. This is the one case where `reason` is not a status, so it
  // is the case the test has to actually bind to.
  it("names the error when the retryable error carries no HTTP status", async () => {
    const { lines, restore } = captureWarnings();
    let calls = 0;
    try {
      await withRetry(
        async () => {
          calls++;
          if (calls < 2) throw new ModelStreamStallError(1000, { retryable: true });
          return "ok";
        },
        3,
        0,
      );
    } finally {
      restore();
    }
    const retries = lines.filter((l) => l.includes("[engine] retry"));
    expect(retries).toHaveLength(1);
    expect(retries[0]).toContain("reason=ModelStreamStallError");
  });

  // The `retryable` branch of isRetryable never inspects `status`, and getStatus
  // is an unchecked cast — so an error can be retryable AND carry a `status` of
  // any shape. `reason` must fall back to the name rather than interpolate it.
  it("ignores a non-retryable status on an error flagged retryable", async () => {
    const { lines, restore } = captureWarnings();
    const err = new ModelStreamStallError(1000, { retryable: true }) as Error & {
      status?: unknown;
    };
    err.status = "sk-should-never-be-logged";
    let calls = 0;
    try {
      await withRetry(
        async () => {
          calls++;
          if (calls < 2) throw err;
          return "ok";
        },
        3,
        0,
      );
    } finally {
      restore();
    }
    const retries = lines.filter((l) => l.includes("[engine] retry"));
    expect(retries).toHaveLength(1);
    expect(retries[0]).toContain("reason=ModelStreamStallError");
    expect(retries[0]).not.toContain("sk-should-never-be-logged");
  });

  it("does not log the provider's error message", async () => {
    const { lines, restore } = captureWarnings();
    let calls = 0;
    try {
      await withRetry(
        async () => {
          calls++;
          if (calls < 2) throw httpError(529, "sk-secret-looking-payload");
          return "ok";
        },
        3,
        0,
      );
    } finally {
      restore();
    }
    const retries = lines.filter((l) => l.includes("[engine] retry"));
    expect(retries).toHaveLength(1);
    expect(retries[0]).not.toContain("sk-secret-looking-payload");
  });

  it("logs every attempt when retries are exhausted", async () => {
    const { lines, restore } = captureWarnings();
    try {
      await withRetry(
        async () => {
          throw httpError(429);
        },
        3,
        0,
      ).catch(() => {});
    } finally {
      restore();
    }
    // 3 retries logged; the 4th (terminal) failure rethrows without a retry line.
    expect(lines.filter((l) => l.includes("[engine] retry"))).toHaveLength(3);
  });
});

/**
 * A provider failure as the engine sees it: `model.doStream()` throws the AI
 * SDK's `APICallError`, which carries the code in `statusCode` (never `status`)
 * and the SDK's own verdict in `isRetryable`.
 */
function apiCallError(
  statusCode: number | undefined,
  responseBody: string,
  contentType = "application/json",
  isRetryable?: boolean,
): APICallError {
  return new APICallError({
    message: "provider failed",
    url: "https://provider.example/v1/messages",
    requestBodyValues: {},
    ...(statusCode !== undefined ? { statusCode } : {}),
    responseHeaders: { "content-type": contentType },
    responseBody,
    ...(isRetryable !== undefined ? { isRetryable } : {}),
  });
}

/** The model gateway's answer to a call past the run's model budget. */
const budgetRefusal = () => apiCallError(429, "rate limit exceeded", "text/plain");

describe("isRetryable — the AI SDK's provider errors", () => {
  it("returns true for a provider's 429 and 529", () => {
    expect(isRetryable(apiCallError(429, '{"error":{"type":"rate_limit_error"}}'))).toBe(true);
    expect(isRetryable(apiCallError(529, '{"error":{"type":"overloaded_error"}}'))).toBe(true);
  });

  it("returns true for a 5xx and a network failure the SDK marks retryable", () => {
    expect(isRetryable(apiCallError(503, "upstream unavailable", "text/plain"))).toBe(true);
    expect(isRetryable(apiCallError(undefined, "", "text/plain", true))).toBe(true);
  });

  it("follows the provider's verdict over the status", () => {
    expect(
      isRetryable(
        apiCallError(429, '{"error":{"code":"insufficient_quota"}}', "application/json", false),
      ),
    ).toBe(false);
  });

  it("returns false for a provider's 400 and 401", () => {
    expect(isRetryable(apiCallError(400, '{"error":"bad request"}'))).toBe(false);
    expect(isRetryable(apiCallError(401, '{"error":"bad key"}'))).toBe(false);
  });

  it("reads `statusCode` when the error states no verdict of its own", () => {
    expect(isRetryable({ statusCode: 429 })).toBe(true);
    expect(isRetryable({ statusCode: 529 })).toBe(true);
    expect(isRetryable({ statusCode: 400 })).toBe(false);
  });

  it("never retries the model gateway's refusal for a spent run budget", () => {
    // The SDK marks every 429 retryable, this one included.
    expect(budgetRefusal().isRetryable).toBe(true);
    expect(isRetryable(budgetRefusal())).toBe(false);
    expect(isRetryable(apiCallError(429, "rate limit exceeded\n", "text/plain"))).toBe(false);
    expect(isRetryable({ statusCode: 429, responseBody: "rate limit exceeded" })).toBe(false);
    expect(isRetryable({ status: 429, responseBody: "rate limit exceeded" })).toBe(false);
  });

  it("still retries a 429 with any other body", () => {
    expect(isRetryable(apiCallError(429, "rate limit exceeded, retry in 1s", "text/plain"))).toBe(
      true,
    );
  });
});

describe("withRetry — the AI SDK's provider errors", () => {
  it("retries a provider's 429 and succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw apiCallError(429, '{"error":{"type":"rate_limit_error"}}');
        return "recovered";
      },
      3,
      0,
    );
    expect(result).toBe("recovered");
    expect(calls).toBe(3);
  });

  it("fails at once on the gateway's budget refusal, rethrowing it unchanged", async () => {
    let calls = 0;
    const refusal = budgetRefusal();
    await expect(
      withRetry(
        async () => {
          calls++;
          throw refusal;
        },
        3,
        0,
      ),
    ).rejects.toBe(refusal);
    expect(calls).toBe(1);
  });

  // A 401 keeps its status and the provider's body, so the turn's error still
  // reports it as a failed model call with the provider's reason.
  it("fails at once on a provider's 401, rethrowing it unchanged", async () => {
    let calls = 0;
    const unauthorized = apiCallError(401, '{"error":"bad key"}');
    await expect(
      withRetry(
        async () => {
          calls++;
          throw unauthorized;
        },
        3,
        0,
      ),
    ).rejects.toBe(unauthorized);
    expect(calls).toBe(1);
  });

  it("retries a real provider's 429 from doStream, but not the gateway's refusal", async () => {
    const answers = [
      () =>
        new Response('{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}', {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
      () =>
        new Response("rate limit exceeded", {
          status: 429,
          headers: { "content-type": "text/plain" },
        }),
    ];
    let requests = 0;
    const fetch = async () => {
      requests++;
      return (answers[requests - 1] ?? answers[1])();
    };
    const model = createAnthropic({
      apiKey: "test-key",
      fetch: fetch as unknown as typeof globalThis.fetch,
    })("claude-sonnet-4-5");
    const failed = await withRetry(
      async () =>
        model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
      3,
      0,
    ).catch((err: unknown) => err);
    // The provider's 429 was retried; the refusal that answered the retry ended it.
    expect(requests).toBe(2);
    expect(APICallError.isInstance(failed)).toBe(true);
    expect((failed as APICallError).responseBody).toBe("rate limit exceeded");
  });
});
