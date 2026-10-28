import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  let status = 200;
  let fetches = 0;
  let now = NOW_MS;
  const auth = createConnectionAuth({
    jwksUrl: "https://runtime.example/.well-known/run-keys.json",
    issuer: ISSUER,
    now: () => now,
    fetch: (async () => {
      fetches++;
      if (status !== 200) return new Response(null, { status });
      return Response.json({ keys: served.map((k) => k.jwk) });
    }) as unknown as typeof fetch,
  });
  return {
    auth,
    fetches: () => fetches,
    serve: (keys: ReturnType<typeof keyPair>[]) => {
      served = keys;
    },
    answer: (code: number) => {
      status = code;
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

  test("stops honoring a removed key once the key set ages out, with no unknown-key traffic", async () => {
    const old = keyPair("k1");
    const s = setUp([old]);
    await s.auth.check(`Bearer ${token(old, valid())}`);

    s.serve([keyPair("k2")]);
    s.advance(300_000);
    await expect(
      s.auth.check(
        `Bearer ${token(old, valid({ iat: (NOW_MS + 300_000) / 1000, exp: (NOW_MS + 600_000) / 1000 }))}`,
      ),
    ).rejects.toThrow(/unknown key/);
    expect(s.fetches()).toBe(2);
  });

  test("throttles refetches after a failed fetch, and refuses on a key set it cannot refresh", async () => {
    const key = keyPair("k1");
    const s = setUp([key]);
    s.answer(503);
    for (let i = 0; i < 5; i++) {
      await expect(s.auth.check(`Bearer ${token(key, valid())}`)).rejects.toBeInstanceOf(
        ConnectionRefused,
      );
    }
    expect(s.fetches()).toBe(1);

    s.answer(200);
    s.advance(30_000);
    await s.auth.check(`Bearer ${token(key, valid())}`);
    expect(s.fetches()).toBe(2);

    // Past its maximum age a set that cannot be refreshed verifies nothing.
    s.answer(503);
    s.advance(300_000);
    const later = valid({ iat: (NOW_MS + 330_000) / 1000, exp: (NOW_MS + 600_000) / 1000 });
    await expect(s.auth.check(`Bearer ${token(key, later)}`)).rejects.toThrow(/answered 503/);
    await expect(s.auth.check(`Bearer ${token(key, later)}`)).rejects.toThrow(/stale/);
    expect(s.fetches()).toBe(3);
  });
});

describe("connection check against a key set file", () => {
  /**
   * A directory laid out as a Kubernetes Secret volume: `run-keys.json` links to
   * `..data/run-keys.json`, and an update writes a new directory and swaps the
   * `..data` symlink onto it.
   */
  function secretVolume(initial: ReturnType<typeof keyPair>[]) {
    const dir = mkdtempSync(join(tmpdir(), "nb-agent-keys-"));
    let version = 0;
    const write = (keys: ReturnType<typeof keyPair>[]) => {
      const target = `..v${++version}`;
      mkdirSync(join(dir, target));
      writeFileSync(
        join(dir, target, "run-keys.json"),
        JSON.stringify({ keys: keys.map((k) => ({ ...k.jwk, alg: "EdDSA", use: "sig" })) }),
      );
      symlinkSync(target, join(dir, "..data_tmp"));
      renameSync(join(dir, "..data_tmp"), join(dir, "..data"));
    };
    write(initial);
    symlinkSync("..data/run-keys.json", join(dir, "run-keys.json"));
    return {
      file: join(dir, "run-keys.json"),
      write,
      remove: () => rmSync(dir, { recursive: true }),
    };
  }

  function setUpFile(initial: ReturnType<typeof keyPair>[]) {
    const volume = secretVolume(initial);
    let now = NOW_MS;
    const auth = createConnectionAuth({ jwksFile: volume.file, issuer: ISSUER, now: () => now });
    return {
      auth,
      volume,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  test("accepts a credential the file's key set verifies", async () => {
    const key = keyPair("k1");
    const s = setUpFile([key]);
    try {
      await s.auth.check(`Bearer ${token(key, valid())}`);
    } finally {
      s.volume.remove();
    }
  });

  test("refuses a credential signed by a key the file does not hold", async () => {
    const s = setUpFile([keyPair("k1")]);
    try {
      // Same key id, another key: the signature does not verify.
      await expect(s.auth.check(`Bearer ${token(keyPair("k1"), valid())}`)).rejects.toThrow(
        /bad signature/,
      );
      await expect(s.auth.check(`Bearer ${token(keyPair("k9"), valid())}`)).rejects.toThrow(
        /unknown key/,
      );
    } finally {
      s.volume.remove();
    }
  });

  test("picks up a key set swapped in under the file, with no restart", async () => {
    const old = keyPair("k1");
    const rotated = keyPair("k2");
    const s = setUpFile([old]);
    try {
      await s.auth.check(`Bearer ${token(old, valid())}`);

      s.volume.write([rotated, old]);
      // Within the interval an unknown key id does not reread.
      await expect(s.auth.check(`Bearer ${token(rotated, valid())}`)).rejects.toThrow(
        /unknown key/,
      );
      s.advance(30_000);
      await s.auth.check(`Bearer ${token(rotated, valid())}`);
      await s.auth.check(`Bearer ${token(old, valid())}`);

      // A key dropped from the file stops verifying once the set ages out.
      s.volume.write([rotated]);
      s.advance(300_000);
      const later = valid({ iat: (NOW_MS + 330_000) / 1000, exp: (NOW_MS + 600_000) / 1000 });
      await expect(s.auth.check(`Bearer ${token(old, later)}`)).rejects.toThrow(/unknown key/);
      await s.auth.check(`Bearer ${token(rotated, later)}`);
    } finally {
      s.volume.remove();
    }
  });

  test("takes exactly one of a URL and a file", () => {
    expect(() => createConnectionAuth({ issuer: ISSUER })).toThrow(/exactly one/);
    expect(() =>
      createConnectionAuth({ issuer: ISSUER, jwksUrl: "http://r/keys", jwksFile: "/keys.json" }),
    ).toThrow(/exactly one/);
  });
});
