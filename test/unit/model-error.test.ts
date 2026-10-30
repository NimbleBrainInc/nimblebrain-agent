import { describe, expect, test } from "bun:test";
import { credentialsOf, modelCallError } from "../../src/acp/model-error.ts";
import type { TurnUsage } from "../../src/acp/session-options.ts";

const usage: TurnUsage = { calls: [], total: { inputTokens: 0, outputTokens: 0 } };

function serialized(responseBody: string, credentials: string[]): string {
  const err = Object.assign(new Error("Unauthorized"), { statusCode: 401, responseBody });
  const failed = modelCallError(err, usage, credentials);
  if (!failed) throw new Error("expected a model-call error");
  return JSON.stringify({ message: failed.message, data: failed.data });
}

describe("credential redaction in a model-call error", () => {
  test("cuts a short route credential and its bare bearer token", () => {
    const credentials = credentialsOf(
      {
        providers: {
          anthropic: {
            baseUrl: "https://gateway.example/v1",
            headers: { Authorization: "Bearer abc1234", "x-key": "k9" },
          },
        },
      },
      {},
    );
    const out = serialized("Invalid token: abc1234 (k9)", credentials);
    expect(out).not.toContain("abc1234");
    expect(out).not.toContain("k9");
  });

  test("cuts a short model key from the process environment", () => {
    const out = serialized("bad key sk-12", credentialsOf(undefined, { OPENAI_API_KEY: "sk-12" }));
    expect(out).not.toContain("sk-12");
  });

  test("leaves short values of variables only named like a credential", () => {
    const credentials = credentialsOf(undefined, { TOKENIZERS_PARALLELISM: "false" });
    expect(credentials).toEqual([]);
    expect(serialized("stream: false", credentials)).toContain("stream: false");
  });
});
