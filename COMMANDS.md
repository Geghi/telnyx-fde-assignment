telnyx-edge storage kv key put 82be9f48-ca78-43f7-a50a-c0109d536465 online_booking_enabled false

# Check callback request when booking is disabled

./scripts/list-callbacks.sh

# Deploy

## webhooks

cd edge-functions/webhook && telnyx-edge ship

## mcp server

cd ../mcp-server && telnyx-edge ship

## assistant

cd assistant-voice-agent && npm run setup

# Trace conversation

## get last conversation

npm run trace

## get specific conversation

npm run trace <id>

## list conversation ids

set -a; . ./.env.local; set +a
curl -sS "https://api.telnyx.com/v2/ai/conversations?page%5Bsize%5D=10" \
 -H "Authorization: Bearer $TELNYX_API_KEY" -o /tmp/convs.json
node -e 'for (const c of require("/tmp/convs.json").data) console.log(c.created_at, c.id, (c.metadata.flow_transitions||[]).length)'
