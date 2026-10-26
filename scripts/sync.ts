#!/usr/bin/env bun
/**
 * Keep nimblebrain-agent's copy of NimbleBrain's engine in step with NimbleBrain.
 *
 *   bun scripts/sync.ts <nimblebrain checkout>          copy every mirrored file, regenerate the event catalog
 *   bun scripts/sync.ts <nimblebrain checkout> --check  exit 1 if any differs, changing nothing
 *
 * The mirrored files are listed in `mirror.txt` and live at the same path in
 * both repos. nimblebrain-agent's own code (`src/acp/`, `src/context/`, `src/cli.ts`,
 * `src/model/resolve.ts`, `src/conversation/types.ts`) is never touched.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const check = args.includes("--check");
const source = args.find((a) => !a.startsWith("--"));
if (!source || !existsSync(join(source, "src/engine/engine.ts"))) {
  process.stderr.write("usage: bun scripts/sync.ts <nimblebrain checkout> [--check]\n");
  process.exit(2);
}

const mirrored = readFileSync(join(ROOT, "mirror.txt"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

const drift: string[] = [];
for (const path of mirrored) {
  const from = join(source, path);
  const to = join(ROOT, path);
  if (!existsSync(from)) {
    drift.push(`${path} (gone from NimbleBrain)`);
    continue;
  }
  const same = existsSync(to) && readFileSync(from).equals(readFileSync(to));
  if (same) continue;
  drift.push(path);
  if (!check) {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

const trimmed = Bun.spawnSync([
  "python3",
  join(ROOT, "scripts/trim-events.py"),
  join(source, "src/engine/schemas/events.ts"),
]);
if (trimmed.exitCode !== 0) {
  process.stderr.write(trimmed.stderr.toString());
  process.exit(1);
}
const eventsPath = join(ROOT, "src/engine/schemas/events.ts");
if (!readFileSync(eventsPath).equals(trimmed.stdout)) {
  drift.push("src/engine/schemas/events.ts (regenerated)");
  if (!check) await Bun.write(eventsPath, trimmed.stdout);
}

if (drift.length === 0) {
  process.stdout.write("in step with NimbleBrain\n");
} else {
  process.stdout.write(
    `${check ? "drifted" : "updated"}:\n${drift.map((d) => `  ${d}`).join("\n")}\n`,
  );
  if (check) process.exit(1);
}
