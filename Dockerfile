# syntax=docker/dockerfile:1
# The worker image: `nimblebrain-agent serve`, ACP over Streamable HTTP at /acp.
#
# Same bun as CI, by an exact tag pinned by digest, so a rebuild of a commit pulls the
# toolchain CI tested (test/unit/build-pins.test.ts checks both). Bump every copy
# together.
FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS deps
WORKDIR /app
# bunfig.toml carries the install policy CI installs under.
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288

LABEL org.opencontainers.image.title="nimblebrain-agent"
LABEL org.opencontainers.image.description="An agent runtime that speaks the Agent Client Protocol"
LABEL org.opencontainers.image.source="https://github.com/NimbleBrainInc/nimblebrain-agent"
LABEL org.opencontainers.image.url="https://nimblebrain.ai"
LABEL org.opencontainers.image.vendor="NimbleBrain"
LABEL org.opencontainers.image.licenses="Apache-2.0"

WORKDIR /app
# Bun runs the TypeScript sources directly: there is no build step, and the
# production dependencies are all the image needs. Root owns the files; the
# process runs as UID 1000 and cannot change them.
COPY --from=deps /app/node_modules node_modules
COPY package.json ./
COPY src/ src/

# UID 1000 is the base image's `bun` user, and matches a Kubernetes securityContext.
USER 1000

# A container listens on every interface; loopback would be unreachable from outside it.
ENV NB_AGENT_HOST=0.0.0.0
ENV NB_AGENT_PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s \
  CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.NB_AGENT_PORT}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["bun", "run", "src/cli.ts", "serve"]
