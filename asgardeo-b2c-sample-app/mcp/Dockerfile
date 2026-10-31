# syntax=docker/dockerfile:1
#
# Wayfinder MCP server (Streamable HTTP at /mcp).
#
# Build context: asgardeo-b2c-sample-app/ (shared with api/Dockerfile; see
# ../.dockerignore), for example:
#   docker build -f mcp/Dockerfile -t wayfinder/mcp asgardeo-b2c-sample-app
#
# The server loads api/src/db.ts in process (data.ts resolves ../api/src/db.ts),
# so the image carries the API's db module and its better-sqlite3 dependency
# next to the MCP code. It opens the same SQLite file as the API through the
# shared volume at DB_PATH; the API container seeds it.

FROM node:22-bookworm-slim AS deps
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY api/package.json api/package-lock.json api/
COPY mcp/package.json mcp/package-lock.json mcp/
RUN cd api && npm ci --omit=dev --no-audit --no-fund \
    && cd ../mcp && npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    MCP_PORT=8000 \
    DB_PATH=/data/wayfinder.db
WORKDIR /app
COPY --from=deps /app/api/node_modules api/node_modules
COPY --from=deps /app/mcp/node_modules mcp/node_modules
COPY api/package.json api/tsconfig.json api/
COPY api/src api/src
COPY mcp/package.json mcp/tsconfig.json mcp/*.ts mcp/
# Same uid as the api image, so both can write the shared volume.
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/mcp
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||8000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--import", "tsx", "server.ts"]
