#!/bin/sh
# Runs the relay, which serves MCP itself over HTTP at /mcp (no separate MCP
# process needed — see relay.ts). Anything else is exec'd verbatim, so
# `docker run … node dist/index.js` (the stdio server, e.g. for file-mode with
# no relay) still works.
set -e

case "$1" in
  relay | "")
    exec node dist/relay.js
    ;;
  *)
    exec "$@"
    ;;
esac