"""Trim NimbleBrain's engine event catalog to the events nimblebrain-agent's engine emits.

NimbleBrain's `src/engine/schemas/events.ts` is the platform's whole event
catalog (connectors, notifications, audit, ...). nimblebrain-agent carries only the run
events its engine emits, so it imports nothing of the platform's types.

    python3 scripts/trim-events.py <nimblebrain>/src/engine/schemas/events.ts > src/engine/schemas/events.ts
"""
import re
import sys

KEEP = {
    "run.start", "run.done", "run.error", "text.delta", "reasoning.delta",
    "tool.preparing", "tool.preparing.done", "tool.start", "tool.done", "tool.progress",
    "tool.promoted", "tool.released", "llm.done", "llm.error", "skills.loaded",
    "connector.skill.injected", "skill.activated", "skill.not_delivered",
    "skill.suppression", "context.assembled", "context.overflow_recovery",
}
PLATFORM_TYPES = ["ConnectionState", "ConnectorUiMeta", "PlacementDeclaration",
                  "UnattendedDispatchClassification", "SealFailureReason",
                  "RelayedServerNotificationMethod"]

src = open(sys.argv[1]).read()
head, rest = src.split("export interface EngineEventPayloads {", 1)
body, tail = rest.split("\n}\n", 1)

# The catalog: one entry per event, each possibly preceded by a doc comment.
entries = re.findall(r'((?:\s*/\*\*(?:.|\n)*?\*/)?\s*"([a-z_.]+)":\s*([^;]+);)', body)
kept = [text for text, key, _ in entries if key in KEEP]
missing = KEEP - {key for _, key, _ in entries}
if missing:
    sys.exit(f"events not in the catalog: {sorted(missing)}")

# The head's top-level chunks: imports, helpers, and payload definitions. Keep
# a definition only if a kept event reaches it, directly or through another
# kept definition; drop the platform imports with everything that needs them.
lines = [l for l in head.split("\n")
         if not re.match(r'import type .* from "\.\./\.\./(connectors|orchestrator|tools)/', l)]
chunks = re.split(r"\n(?=/\*\*|export |const |function |// ──)", "\n".join(lines))
DEFINES = re.compile(r"^(?:/\*\*(?:.|\n)*?\*/\s*)?(?:export\s+)?(?:const|type|function|interface)\s+(\w+)", re.M)

def defined(chunk):
    m = DEFINES.match(chunk.lstrip())
    return m.group(1) if m else None

def words(text):
    return set(re.findall(r"\b[A-Za-z_]\w*\b", text))

by_name = {}
for c in chunks:
    name = defined(c)
    if name:
        by_name.setdefault(name, []).append(c)
needed = set()
frontier = words(" ".join(kept))
while frontier:
    name = frontier.pop()
    if name in needed or name not in by_name:
        continue
    needed.add(name)
    for c in by_name[name]:
        frontier |= words(c)
out = []
for c in chunks:
    name = defined(c)
    if name is None:
        # Imports and the file's opening comment stay; a section rule alone does not.
        if c.lstrip().startswith("// ──"):
            continue
        out.append(c)
    elif name in needed and not any(t in c for t in PLATFORM_TYPES):
        out.append(c)
head = "\n".join(out) + "\n\n"

sys.stdout.write(head + "export interface EngineEventPayloads {" + "".join(kept) + "\n}\n" + tail)
