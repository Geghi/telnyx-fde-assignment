#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="82be9f48-ca78-43f7-a50a-c0109d536465"

echo "==> Seeding KV namespace $NAMESPACE..."

# Feature flags
telnyx-edge storage kv key put "$NAMESPACE" online_booking_enabled "true"

# Cached content
telnyx-edge storage kv key put "$NAMESPACE" clinic_hours \
  "Mon-Thu 7am-7pm, Fri 8am-4pm. Sat 9am-2pm. Sun closed."

echo "==> Verifying..."
telnyx-edge storage kv key get "$NAMESPACE" online_booking_enabled
telnyx-edge storage kv key get "$NAMESPACE" clinic_hours

echo "==> KV seed complete."
