#!/usr/bin/env bash
set -euo pipefail

# Helper: ship both functions and print their URLs.
# Run from repo root.

echo "==> Shipping Webhook..."
cd edge-functions/webhook
telnyx-edge ship
cd - >/dev/null

echo ""
echo "==> Shipping MCP Server..."
cd edge-functions/mcp-server
telnyx-edge ship
cd - >/dev/null

echo ""
echo "==> Done. Check your function URLs above:"
echo "   - Webhook    -> https://webhook-<org>.telnyxcompute.com"
echo "   - MCP Server -> https://mcp-server-<org>.telnyxcompute.com"
