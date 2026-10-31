# Asgardeo Self Service MCP Server (asgardeo/asgardeo-mcp-server, cmd/self-service-mcp), built from a pinned commit.
# The Wayfinder account assistant calls it with the signed-in user's own access token; it serves MCP over Streamable
# HTTP at :${PORT}/mcp and keeps no session or token. Configuration: BASE_URL (https://<api host>/t/<org>), CLIENT_ID
# (the app the token comes from), PORTAL_NAME; see the repository's docs/self-service-mcp.md.
FROM golang:1.24-alpine AS build
ARG ASGARDEO_MCP_REPO=https://github.com/asgardeo/asgardeo-mcp-server
ARG ASGARDEO_MCP_COMMIT=ea6f29c1e5376921e330df1cd9094948d7fba0a9
RUN apk add --no-cache git
WORKDIR /src
RUN git init -q . \
 && git fetch -q --depth 1 "$ASGARDEO_MCP_REPO" "$ASGARDEO_MCP_COMMIT" \
 && git checkout -q FETCH_HEAD \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/self-service-mcp ./cmd/self-service-mcp

FROM alpine:3.22
RUN apk add --no-cache ca-certificates && adduser -D -H -u 10001 mcp
COPY --from=build /out/self-service-mcp /usr/local/bin/self-service-mcp
USER 10001
ENV PORT=8000 TRANSPORT=http
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/self-service-mcp"]
