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
sync edge-functions/package-lock.json npm ci --prefix edge-functions
sync assistant-voice-agent/uv.lock uv sync --directory assistant-voice-agent
