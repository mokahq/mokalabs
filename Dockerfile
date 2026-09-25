# syntax=docker/dockerfile:1.7
# Moka sandbox — any LLM, any MCP server, any skill.
#   docker run --rm -p 4000:4000 -e OPENAI_API_KEY ghcr.io/mokalabs/moka
#   docker run --rm -p 4000:4000 -v "$PWD:/workspace" ghcr.io/mokalabs/moka   # uses ./moka.json

ARG UV_IMAGE=ghcr.io/astral-sh/uv:latest
FROM ${UV_IMAGE} AS uv

FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/sandbox/package.json packages/sandbox/
COPY packages/create-moka/package.json packages/create-moka/
COPY apps/docs/package.json apps/docs/
# Only install what the sandbox needs (skips the docs site's toolchain).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "@mokalabs/sandbox..."
COPY . .
RUN pnpm --filter @mokalabs/core --filter @mokalabs/sandbox run build \
 && pnpm --filter @mokalabs/sandbox deploy --prod --legacy /out

FROM node:22-bookworm-slim
LABEL org.opencontainers.image.title="Moka sandbox" \
      org.opencontainers.image.description="Chat with any LLM, plug in any MCP server or skill, inspect every call." \
      org.opencontainers.image.source="https://github.com/mokalabs/moka" \
      org.opencontainers.image.licenses="MIT"
# git + uv/uvx so Python MCP servers (uvx mcp-server-*) work out of the box; npx ships with node.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=build /out /opt/moka
RUN ln -s /opt/moka/dist/cli.js /usr/local/bin/moka && chmod +x /opt/moka/dist/cli.js \
 && mkdir -p /data /workspace && chown -R node:node /data /workspace
ENV NODE_ENV=production \
    MOKA_HOST=0.0.0.0 \
    MOKA_HOME=/data \
    MOKA_NO_OPEN=1 \
    PORT=4000
USER node
WORKDIR /workspace
VOLUME ["/data"]
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "moka"]
