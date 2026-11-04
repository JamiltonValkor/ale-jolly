#!/bin/bash
# Fake docker CLI for the watcher tests: records each call (no values) and
# keeps per-container state (absent|true|false). The Hermes container uses
# $FAKE_DOCKER_STATE (backward compatible); others $FAKE_DOCKER_STATE.<name>.
set -euo pipefail
echo "$1 ${2:-}" >>"$FAKE_DOCKER_LOG"
state_file() { if [ "$1" = hermes ]; then echo "$FAKE_DOCKER_STATE"; else echo "$FAKE_DOCKER_STATE.$1"; fi; }
get_state() { cat "$(state_file "$1")" 2>/dev/null || echo absent; }
last() { eval "echo \${$#}"; }
case "$1" in
  image) exit 0 ;;
  pull) echo "$2" >>"$FAKE_DOCKER_STATE.pulls"; exit 0 ;;
  inspect)
    name=$(last "$@")
    st=$(get_state "$name")
    [ "$st" = absent ] && exit 1
    if [ "${3:-}" = '{{json .NetworkSettings.Networks}}' ]; then
      if grep -qx "$name" "$FAKE_DOCKER_STATE.connected" 2>/dev/null; then echo '{"bridge":{},"hermes-net":{}}'; else echo '{"bridge":{}}'; fi
    else echo "$st"; fi ;;
  run)
    name=hermes; prev=""
    for a in "$@"; do [ "$prev" = --name ] && name=$a; prev=$a; done
    if [ "$name" = hermes ]; then printf '%s\n' "$@" >"$FAKE_DOCKER_STATE.run-args"; else printf '%s\n' "$@" >"$FAKE_DOCKER_STATE.run-args.$name"; fi
    for a in "$@"; do if [ "$a" = hermes-net ]; then echo "$name" >>"$FAKE_DOCKER_STATE.connected"; break; fi; done
    echo true >"$(state_file "$name")" ;;
  start) echo true >"$(state_file "${2:-hermes}")" ;;
  stop) echo false >"$(state_file "$(last "$@")")" ;;
  restart) echo true >"$(state_file "${2:-hermes}")" ;;
  rm) echo absent >"$(state_file "$(last "$@")")" ;;
  network)
    case "$2" in
      inspect) [ -f "$FAKE_DOCKER_STATE.network" ] ;;
      create) touch "$FAKE_DOCKER_STATE.network" ;;
      connect) echo "$4" >>"$FAKE_DOCKER_STATE.connected" ;;
      *) exit 2 ;;
    esac ;;
  exec)
    shift
    case "$*" in
      "hermes hermes cron list") cat "$FAKE_DOCKER_STATE.cron" 2>/dev/null || true ;;
      "hermes hermes cron create"*)
        prev=""; for a in "$@"; do [ "$prev" = --name ] && echo "    Name:      $a" >>"$FAKE_DOCKER_STATE.cron"; prev=$a; done ;;
      "hermes hermes profile create "*)
        # Like Hermes: refuses an existing profile, then publishes the dir with an identity file.
        n=$5; dir="$HERMES_DATA_DIR/profiles/$n"
        if [ -f "$dir/profile.yaml" ] || [ -f "$dir/SOUL.md" ] || [ -f "$dir/state.db" ]; then echo "A profile named '$n' already exists." >&2; exit 1; fi
        mkdir -p "$dir"; echo "name: $n" >"$dir/profile.yaml"; echo "$n" >>"$FAKE_DOCKER_STATE.profiles" ;;
      "hermes hermes tools enable kanban --platform "*) echo "$7" >>"$FAKE_DOCKER_STATE.toolsets" ;;
      "saleads-brain saleads-brain ingest-seed"*) [ "${FAKE_INGEST_FAIL:-0}" = 1 ] && exit 1; echo ok >>"$FAKE_DOCKER_STATE.ingested" ;;
      *) echo "fake-docker: unexpected exec $*" >&2; exit 2 ;;
    esac ;;
  *) echo "fake-docker: unexpected $1" >&2; exit 2 ;;
esac
