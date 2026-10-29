import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A rebuild of the same commit must pull the same base image and the same bun CI
// tested, or the image can change while nothing in the repo did.

const root = join(import.meta.dir, "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const fromLines = () =>
  read("Dockerfile")
    .split("\n")
    .flatMap((line) => line.match(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i)?.[1] ?? []);

describe("image build inputs are pinned", () => {
  test("every base image is pinned by digest", () => {
    const refs = fromLines();
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  test("the image's bun is CI's", () => {
    const ci = read(".github/workflows/ci.yml").match(/^\s*BUN_VERSION:\s*"([^"]+)"/m)?.[1];
    expect(ci).toBeDefined();
    for (const ref of fromLines()) expect(ref.match(/^oven\/bun:([0-9.]+)-/)?.[1]).toBe(ci);
  });
});
