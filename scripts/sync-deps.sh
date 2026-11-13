#!/bin/sh
set -e
sync() {
  lock=$1
  shift
  [ -f "$lock" ] || return 0
  stamp=$(git rev-parse --git-path "deps-$(echo "$lock" | tr / _).sha")
  new=$(git hash-object "$lock")
  [ "$(cat "$stamp" 2>/dev/null)" = "$new" ] && return 0
  "$@"
  echo "$new" > "$stamp"
}
sync edge-functions/webhook/package-lock.json npm ci --prefix edge-functions/webhook
sync edge-functions/mcp-server/package-lock.json npm ci --prefix edge-functions/mcp-server
