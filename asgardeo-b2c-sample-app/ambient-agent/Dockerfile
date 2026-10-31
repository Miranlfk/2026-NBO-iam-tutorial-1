# syntax=docker/dockerfile:1
#
# Wayfinder ambient agent (new-flight webhook at /deal-alerts, port 8790).
# Internal only: the API posts to it over the Docker network.
#
# Build context: asgardeo-b2c-sample-app/ambient-agent/, for example:
#   docker build -t wayfinder/ambient-agent asgardeo-b2c-sample-app/ambient-agent

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    AGENT_PORT=8790
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json *.ts ./
USER node
EXPOSE 8790
# /health also confirms the agent token and the MCP tools are loaded.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||process.env.AGENT_PORT||8790)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# tsx runs the TypeScript sources directly, as `npm start` does.
CMD ["node", "--import", "tsx", "agent.ts"]
