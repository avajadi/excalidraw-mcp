#!/bin/sh
# One image, two roles:
#   relay (default) — the long-lived HTTP/WebSocket service + live canvas.
#   mcp             — the stdio MCP server Claude spawns; talks to the relay via
#                     EXCALIDRAW_RELAY_URL (falls back to file-only if unset).
# Anything else is exec'd verbatim, so `docker run … node foo.js` still works.
set -e

case "$1" in
  relay | "")
    exec node dist/relay.js
    ;;
  mcp)
    exec node dist/index.js
    ;;
  *)
    exec "$@"
    ;;
esac