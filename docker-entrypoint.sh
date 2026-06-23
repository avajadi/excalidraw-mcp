#!/bin/sh
# One image, two roles:
#   relay (default) — the long-lived HTTP/WebSocket service + live canvas.
#   mcp             — the stdio MCP server Claude spawns; talks to the relay via
#                     EXCALIDRAW_RELAY_URL (falls back to file-only if unset).
# Anything else is exec'd verbatim, so `docker run … node foo.js` still works.
set -e

# Record the role so the image HEALTHCHECK can tell them apart: the stdio mcp
# role has no HTTP port, so an HTTP probe would mark a working container
# unhealthy. Best-effort — a read-only rootfs just leaves the marker absent.
role="${1:-relay}"
echo "$role" > /tmp/excalidraw-role 2>/dev/null || true

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