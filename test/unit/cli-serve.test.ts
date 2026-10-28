import { describe, expect, test } from "bun:test";
import { connectionAuthFrom } from "../../src/cli.ts";

describe("serve's connection check, from the environment", () => {
  test("needs the runtime's key set and issuer", () => {
    expect(() => connectionAuthFrom({})).toThrow(/NB_AGENT_AUTH_JWKS_URL and NB_AGENT_AUTH_ISSUER/);
    expect(() => connectionAuthFrom({ NB_AGENT_AUTH_JWKS_URL: "http://r/keys" })).toThrow();
    expect(
      connectionAuthFrom({
        NB_AGENT_AUTH_JWKS_URL: "http://r/.well-known/run-keys.json",
        NB_AGENT_AUTH_ISSUER: "https://r",
      }),
    ).not.toBeNull();
  });

  test("runs without one only when told to", () => {
    expect(connectionAuthFrom({ NB_AGENT_AUTH: "none" })).toBeNull();
  });
});
