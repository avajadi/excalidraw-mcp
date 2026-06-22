# excalidraw-mcp-relay

The live-view **relay** for [excalidraw-mcp](https://github.com/avajadi/excalidraw-mcp) — an
[MCP](https://modelcontextprotocol.io) server that turns natural-language prompts into
[Excalidraw](https://excalidraw.com) diagrams.

This image is the long-lived service: it serves the companion web canvas and bridges scene
updates over WebSocket. The MCP server itself is **not** in this image — Claude spawns it on
the host over stdio and points it at this relay.

## Supported tags

- `latest` — newest build from `main`
- `X.Y.Z` — the `package.json` version (e.g. `1.0.0`)
- `X.Y` / `X.Y.Z` from `v*` git tags (semver)
- `sha-<commit>` — a specific commit

## Supported architectures

`linux/amd64` and `linux/arm64`.

## Quick start

```bash
docker run -d \
  --name excalidraw-relay \
  -p 127.0.0.1:3030:3030 \
  -v excalidraw-scenes:/data \
  avajadi/excalidraw-mcp-relay:latest
```

Then open <http://localhost:3030/>.

The port is bound to `127.0.0.1` on purpose — the scene API and WebSocket are
**unauthenticated**. If you expose the relay beyond localhost, put an authenticating TLS
proxy in front of it.

## docker-compose

```yaml
services:
  relay:
    image: avajadi/excalidraw-mcp-relay:latest
    container_name: excalidraw-relay
    ports:
      - "127.0.0.1:3030:3030"
    environment:
      RELAY_PORT: "3030"
      EXCALIDRAW_OUTPUT_DIR: /data
    volumes:
      - excalidraw-scenes:/data
    restart: unless-stopped

volumes:
  excalidraw-scenes:
```

## Configuration

| Variable                | Default | Description                                        |
| ----------------------- | ------- | -------------------------------------------------- |
| `RELAY_PORT`            | `3030`  | Port the relay listens on (also the exposed port). |
| `EXCALIDRAW_OUTPUT_DIR` | `/data` | Where scenes are persisted.                        |
| `NODE_ENV`              | `production` | Node runtime mode.                            |

- **Volume:** `/data` holds saved scenes — mount a named volume to keep them across restarts.
- **Healthcheck:** built in; polls `GET /scenes` and reports `healthy` once the relay responds.

## Connecting the MCP server

Run the host-side MCP server and point it at this container:

```bash
claude mcp add excalidraw \
  --env EXCALIDRAW_RELAY_URL=http://localhost:3030 \
  -- node /absolute/path/to/excalidraw-mcp/dist/index.js
```

See the [project README](https://github.com/avajadi/excalidraw-mcp) for full usage.

## License

[Apache License 2.0](https://github.com/avajadi/excalidraw-mcp/blob/main/LICENSE).