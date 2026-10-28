import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import {
  CONNECTION_AUDIENCE,
  ConnectionRefused,
  createConnectionAuth,
} from "../../src/serve/connection-auth.ts";

const ISSUER = "https://runtime.example";
const NOW_MS = 1_800_000_000_000;

function keyPair(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  return { kid, privateKey, jwk: { ...jwk, kid } };
}

function token(
  key: { kid: string; privateKey: KeyObject },
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const input = `${b64({ alg: "EdDSA", typ: "JWT", kid: key.kid, ...header })}.${b64(claims)}`;
  return `${input}.${sign(null, Buffer.from(input), key.privateKey).toString("base64url")}`;
}

const valid = (overrides: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: CONNECTION_AUDIENCE,
  sub: "pool",
  iat: NOW_MS / 1000,
  exp: NOW_MS / 1000 + 300,
  ...overrides,
});

function setUp(initial: ReturnType<typeof keyPair>[]) {
  let served = initial;
  let fetches = 0;
  let now = NOW_MS;
  const auth = createConnectionAuth({
    jwksUrl: "https://runtime.example/.well-known/run-keys.json",
    issuer: ISSUER,
    now: () => now,
    fetch: (async () => {
      fetches++;
      return Response.json({ keys: served.map((k) => k.jwk) });
    }) as unknown as typeof fetch,
  });
  return {
    auth,
    fetches: () => fetches,
    serve: (keys: ReturnType<typeof keyPair>[]) => {
      served = keys;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("connection check", () => {
  test("accepts a credential the runtime's key set verifies", async () => {
    const key = keyPair("k1");
    const { auth } = setUp([key]);
    await auth.check(`Bearer ${token(key, valid())}`);
  });

  test.each([
    ["no bearer", () => null],
    [
      "another issuer",
      (k: ReturnType<typeof keyPair>) => `Bearer ${token(k, valid({ iss: "https://other" }))}`,
    ],
    [
      "another audience",
      (k: ReturnType<typeof keyPair>) => `Bearer ${token(k, valid({ aud: "model-gateway" }))}`,
    ],
    [
      "an expired credential",
      (k: ReturnType<typeof keyPair>) => `Bearer ${token(k, valid({ exp: NOW_MS / 1000 - 120 }))}`,
    ],
    [
      "one issued in the future",
      (k: ReturnType<typeof keyPair>) => `Bearer ${token(k, valid({ iat: NOW_MS / 1000 + 600 }))}`,
    ],
    [
      "another algorithm",
      (k: ReturnType<typeof keyPair>) => `Bearer ${token(k, valid(), { alg: "HS256" })}`,
    ],
    ["a forged signature", () => `Bearer ${token(keyPair("k1"), valid())}`],
    ["garbage", () => "Bearer not.a.jws.at-all"],
  ])("refuses %s", async (_case, authorization) => {
    const key = keyPair("k1");
    const { auth } = setUp([key]);
    await expect(auth.check(authorization(key))).rejects.toBeInstanceOf(ConnectionRefused);
  });

  test("picks up a rotated key, and fetches the key set at most once per interval", async () => {
    const old = keyPair("k1");
    const rotated = keyPair("k2");
    const s = setUp([old]);
    await s.auth.check(`Bearer ${token(old, valid())}`);
    expect(s.fetches()).toBe(1);

    s.serve([rotated, old]);
    // Within the interval an unknown key id does not refetch.
    await expect(s.auth.check(`Bearer ${token(rotated, valid())}`)).rejects.toThrow(/unknown key/);
    expect(s.fetches()).toBe(1);

    s.advance(30_000);
    await s.auth.check(`Bearer ${token(rotated, valid())}`);
    expect(s.fetches()).toBe(2);
    // The outgoing key still verifies until it leaves the set.
    await s.auth.check(`Bearer ${token(old, valid())}`);
  });
});
