# syntax=docker/dockerfile:1
#
# Wayfinder SPA. Built once, configured at container start: the entrypoint
# writes /env-config.js from VITE_* environment variables (same names as
# .env.example), so the image carries no domain or identity-provider values.
#
# Build context: asgardeo-b2c-sample-app/frontend/, for example:
#   docker build -t wayfinder/frontend asgardeo-b2c-sample-app/frontend

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.28-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=0755 docker/40-wayfinder-env-config.sh /docker-entrypoint.d/40-wayfinder-env-config.sh
COPY --from=build /app/dist /usr/share/nginx/html
# The entrypoint (running as the unprivileged nginx user) rewrites this file.
USER root
RUN chown 101:101 /usr/share/nginx/html/env-config.js
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
