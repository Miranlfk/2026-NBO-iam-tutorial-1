#!/bin/sh
# Writes /env-config.js from the container environment, so one image of the
# SPA serves any domain and identity provider. Runs from the nginx image's
# /docker-entrypoint.d before nginx starts. src/config.js reads the values and
# falls back to the build-time VITE_* ones for anything left empty.
set -eu

target="${WAYFINDER_ENV_CONFIG_PATH:-/usr/share/nginx/html/env-config.js}"

# Escape for a double-quoted JavaScript string: backslashes, quotes, and "<"
# (so a value cannot close the script element); line breaks are dropped.
js_string() {
    printf '%s' "$1" | tr -d '\r\n' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/</\\u003c/g'
}

{
    printf 'window.__WAYFINDER_ENV__ = {\n'
    separator=""
    for name in \
        VITE_ASGARDEO_CLIENT_ID \
        VITE_ASGARDEO_APPLICATION_ID \
        VITE_ASGARDEO_BASE_URL \
        VITE_ASGARDEO_ORG_NAME \
        VITE_ASGARDEO_SIGN_UP_URL \
        VITE_ASGARDEO_SCOPES \
        VITE_API_BASE_URL \
        VITE_AGENT_API_BASE_URL \
        VITE_WALLET_CREDENTIAL_OFFER \
        VITE_MY_ACCOUNT_URL \
        VITE_STEP_UP_ACR_FACE \
        VITE_STEP_UP_ACR_HIGH_VALUE \
        VITE_HIGH_VALUE_FARE_LIMIT \
        VITE_WALLET_SIGN_IN_CONNECTION \
        VITE_SIWE_SIGN_IN_CONNECTION
    do
        eval "value=\${$name:-}"
        printf '%s  "%s": "%s"' "$separator" "$name" "$(js_string "$value")"
        separator=",
"
    done
    printf '\n};\n'
} > "$target"

echo "wayfinder: wrote runtime configuration to $target"
