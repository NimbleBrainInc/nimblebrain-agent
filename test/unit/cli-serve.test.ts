import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionAuthFrom } from "../../src/cli.ts";

describe("serve's connection check, from the environment", () => {
  test("needs the runtime's key set and issuer", () => {
    expect(() => connectionAuthFrom({})).toThrow(
      /NB_AGENT_AUTH_JWKS_URL \(or NB_AGENT_AUTH_JWKS_FILE\) and NB_AGENT_AUTH_ISSUER/,
    );
    expect(() => connectionAuthFrom({ NB_AGENT_AUTH_JWKS_URL: "http://r/keys" })).toThrow();
    expect(
      connectionAuthFrom({
        NB_AGENT_AUTH_JWKS_URL: "http://r/.well-known/run-keys.json",
        NB_AGENT_AUTH_ISSUER: "https://r",
      }),
    ).not.toBeNull();
  });

  test("takes the key set from a file instead of a URL, but not from both", () => {
    const dir = mkdtempSync(join(tmpdir(), "nb-agent-keys-"));
    const file = join(dir, "run-keys.json");
    writeFileSync(file, JSON.stringify({ keys: [] }));
    try {
      expect(
        connectionAuthFrom({ NB_AGENT_AUTH_JWKS_FILE: file, NB_AGENT_AUTH_ISSUER: "https://r" }),
      ).not.toBeNull();
      expect(() =>
        connectionAuthFrom({
          NB_AGENT_AUTH_JWKS_FILE: file,
          NB_AGENT_AUTH_JWKS_URL: "http://r/.well-known/run-keys.json",
          NB_AGENT_AUTH_ISSUER: "https://r",
        }),
      ).toThrow(/not both/);
      expect(() => connectionAuthFrom({ NB_AGENT_AUTH_JWKS_FILE: file })).toThrow(
        /NB_AGENT_AUTH_ISSUER/,
      );
      expect(() =>
        connectionAuthFrom({
          NB_AGENT_AUTH_JWKS_FILE: join(dir, "missing.json"),
          NB_AGENT_AUTH_ISSUER: "https://r",
        }),
      ).toThrow(/does not exist/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("runs without one only when told to", () => {
    expect(connectionAuthFrom({ NB_AGENT_AUTH: "none" })).toBeNull();
  });
});
