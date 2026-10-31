# syntax=docker/dockerfile:1
#
# Wayfinder REST API.
#
# Build context: asgardeo-b2c-sample-app/ (shared with mcp/Dockerfile; see
# ../.dockerignore), for example:
#   docker build -f api/Dockerfile -t wayfinder/api asgardeo-b2c-sample-app
#
# The SQLite file lives on a volume at DB_PATH (/data/wayfinder.db). On start
# the container seeds it only if the catalogue tables are missing, so an
# existing database and its bookings survive restarts and image upgrades.

FROM node:22-bookworm-slim AS deps
# better-sqlite3 normally downloads a prebuilt binary; the toolchain is the
# fallback for platforms without one. It stays in this stage only.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/api
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/data/wayfinder.db
WORKDIR /app/api
COPY --from=deps /app/api/node_modules ./node_modules
COPY api/package.json api/tsconfig.json api/schema.sql ./
COPY api/scripts/seed.js ./scripts/seed.js
COPY api/src ./src
# A new named volume mounted here inherits this ownership, so the non-root
# user (uid 1000, shared with the mcp image) can create the database.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# tsx runs the TypeScript sources directly, as `npm start` does.
CMD ["sh", "-c", "node scripts/seed.js --if-missing && exec node --import tsx src/server.ts"]
