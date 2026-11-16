#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="82be9f48-ca78-43f7-a50a-c0109d536465"

echo "==> Seeding KV namespace $NAMESPACE..."

# Feature flag (webhook reads this directly)
telnyx-edge storage kv key put "$NAMESPACE" online_booking_enabled "true"

# Canonical clinic config — single source of truth.
# Both the webhook (clinic_hours dynamic variable) and the MCP server
# (get_business_info / get_services tools) read from this one blob.
# If KV is missing or unreadable, both fall back to their internal defaults.
BUSINESS_INFO=$(cat <<'JSON'
{"name":"Bright Smile Dental","hours":"Mon-Fri 8am-6pm, Sat 9am-2pm, Sun closed","location":"123 Smile Ave, Springfield, IL 62701","phone":"+12175551234","policy":"Please arrive 15 minutes early. Cancel at least 24 hours in advance to avoid a fee.","services":[{"name":"Routine Cleaning","price":95,"description":"Professional cleaning and polishing, including X-rays if due."},{"name":"Dental Exam","price":75,"description":"Comprehensive oral health examination by one of our dentists."},{"name":"Root Canal","price":800,"description":"Endodontic treatment to save a damaged or infected tooth."},{"name":"Tooth Extraction","price":250,"description":"Simple or surgical extraction depending on complexity."},{"name":"Teeth Whitening","price":350,"description":"In-office professional whitening for a brighter smile."}]}
JSON
)
telnyx-edge storage kv key put "$NAMESPACE" business_info "$BUSINESS_INFO"

echo "==> Verifying..."
telnyx-edge storage kv key get "$NAMESPACE" online_booking_enabled
telnyx-edge storage kv key get "$NAMESPACE" business_info

echo "==> KV seed complete."
