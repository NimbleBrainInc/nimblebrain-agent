/**
 * Who may open a connection to a serving worker: the runtime that runs its
 * pool, proving it with a connection credential on every request.
 *
 * The credential is a compact JWS (`alg: EdDSA`, Ed25519) the runtime signs
 * with its run key. The worker holds no secret to check it with: it reads the
 * runtime's public key set from a URL it is configured with, and verifies the
 * issuer, the audience (`acp-worker`, which no other credential the runtime
 * mints carries), and the expiry. A key it does not know, or a key set older
 * than its maximum age, sends it back to the key set, at most once per refresh
 * interval whether the fetch succeeds or fails: a rotation is picked up, a key
 * removed from the set stops verifying within the maximum age, and a flood of
 * unknown key ids is not a flood of fetches. A set it cannot refresh past its
 * maximum age verifies nothing.
 */

import { createPublicKey, type KeyObject, verify } from "node:crypto";

/** The audience of a connection credential. */
export const CONNECTION_AUDIENCE = "acp-worker";

/** Clock skew allowed against the runtime's clock. */
const LEEWAY_S = 60;

/** The least time between two fetches of the key set. */
const REFRESH_INTERVAL_MS = 30_000;

/** How long a fetched key set is trusted: the bound on honoring a removed key. */
const MAX_KEY_SET_AGE_MS = 300_000;

export interface ConnectionAuthOptions {
  /** The runtime's public key set (its `/.well-known/run-keys.json`). */
  jwksUrl: string;
  /** The issuer the runtime names itself as: its public origin. */
  issuer: string;
  audience?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

/** Why a request was refused. The reason is logged; the caller sees only a 401. */
export class ConnectionRefused extends Error {}

export interface ConnectionAuth {
  /** Accept the request's `Authorization: Bearer` credential, or throw {@link ConnectionRefused}. */
  check(authorization: string | null): Promise<void>;
}

interface Jwk {
  kty?: string;
  crv?: string;
  x?: string;
  kid?: string;
}

export function createConnectionAuth(opts: ConnectionAuthOptions): ConnectionAuth {
  const audience = opts.audience ?? CONNECTION_AUDIENCE;
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  let keys = new Map<string, KeyObject>();
  let fetchedAt = Number.NEGATIVE_INFINITY;
  let attemptedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;

  const refresh = () => {
    inFlight ??= (async () => {
      attemptedAt = now();
      try {
        keys = await fetchKeySet(fetchFn, opts.jwksUrl);
        fetchedAt = now();
      } catch (err) {
        if (err instanceof ConnectionRefused) throw err;
        throw new ConnectionRefused(
          `key set unreachable: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const fresh = () => now() - fetchedAt < MAX_KEY_SET_AGE_MS;

  const keyFor = async (kid: string): Promise<KeyObject> => {
    const known = keys.get(kid);
    if (known && fresh()) return known;
    // A fetch in flight is joined, so a burst at start waits for the one fetch.
    if (inFlight || now() - attemptedAt >= REFRESH_INTERVAL_MS) await refresh();
    const fetched = keys.get(kid);
    if (!fetched) throw new ConnectionRefused("unknown key id");
    if (!fresh()) throw new ConnectionRefused("key set stale");
    return fetched;
  };

  return {
    async check(authorization) {
      const jws = parseJws(authorization);
      const key = await keyFor(jws.kid);
      if (!verify(null, jws.signed, key, jws.signature)) {
        throw new ConnectionRefused("bad signature");
      }
      checkClaims(jws.claims, { issuer: opts.issuer, audience, nowS: now() / 1000 });
    },
  };
}

/** The runtime's Ed25519 keys by key id; other keys in the set are skipped. */
async function fetchKeySet(
  fetchFn: typeof globalThis.fetch,
  url: string,
): Promise<Map<string, KeyObject>> {
  const res = await fetchFn(url);
  if (!res.ok) throw new ConnectionRefused(`key set answered ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, KeyObject>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.kid || !jwk.x) continue;
    keys.set(
      jwk.kid,
      createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: jwk.x }, format: "jwk" }),
    );
  }
  return keys;
}

interface Jws {
  kid: string;
  signed: Buffer;
  signature: Buffer;
  claims: Claims;
}

interface Claims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  iat?: unknown;
}

/** A bearer credential as an EdDSA compact JWS, or a refusal. */
function parseJws(authorization: string | null): Jws {
  if (!authorization?.startsWith("Bearer ")) throw new ConnectionRefused("no bearer credential");
  const [headerPart, claimsPart, signaturePart, ...rest] = authorization
    .slice("Bearer ".length)
    .split(".");
  if (!headerPart || !claimsPart || !signaturePart || rest.length > 0) {
    throw new ConnectionRefused("not a compact JWS");
  }
  const header = decode(headerPart) as { alg?: unknown; kid?: unknown };
  if (header.alg !== "EdDSA" || typeof header.kid !== "string") {
    throw new ConnectionRefused("not an EdDSA credential with a key id");
  }
  return {
    kid: header.kid,
    signed: Buffer.from(`${headerPart}.${claimsPart}`, "ascii"),
    signature: Buffer.from(signaturePart, "base64url"),
    claims: decode(claimsPart) as Claims,
  };
}

/** The claims of a verified credential: this runtime, this audience, in date. */
function checkClaims(
  claims: Claims,
  expect: { issuer: string; audience: string; nowS: number },
): void {
  if (claims.iss !== expect.issuer) throw new ConnectionRefused("wrong issuer");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expect.audience)) throw new ConnectionRefused("wrong audience");
  if (typeof claims.exp !== "number" || claims.exp + LEEWAY_S <= expect.nowS) {
    throw new ConnectionRefused("expired");
  }
  if (typeof claims.iat === "number" && claims.iat - LEEWAY_S > expect.nowS) {
    throw new ConnectionRefused("issued in the future");
  }
}

function decode(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new ConnectionRefused("unreadable credential");
  }
}
