#!/usr/bin/env bash
# List the call-back requests the front desk has to handle (GET /callbacks).
# Reads STAFF_TOKEN and MCP_SERVER_URL from .env.local (falls back to .env.example).
# STAFF_TOKEN must match the edge secret: telnyx-edge secrets add STAFF_TOKEN <value>
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
. ./.env.example
[ -f .env.local ] && . ./.env.local
set +a

: "${STAFF_TOKEN:?Set STAFF_TOKEN in .env.local (same value as the edge secret)}"
: "${MCP_SERVER_URL:?Set MCP_SERVER_URL in .env.local}"

curl -sS -w '\nHTTP %{http_code}\n' \
  -H "Authorization: Bearer $STAFF_TOKEN" \
  "${MCP_SERVER_URL%/}/callbacks"
