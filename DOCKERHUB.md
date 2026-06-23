# excalidraw-mcp-relay

The live-view **relay** for [excalidraw-mcp](https://github.com/avajadi/excalidraw-mcp) — an
[MCP](https://modelcontextprotocol.io) server that turns natural-language prompts into
[Excalidraw](https://excalidraw.com) diagrams.

This image ships **two roles** from one binary set:

- `relay` (default) — the long-lived service that serves the companion web canvas and bridges
  scene updates over WebSocket. This is what you run as a persistent container.
- `mcp` — the stdio MCP server Claude spawns per session. It connects to the relay so you can
  run it in Docker too, instead of on the host.

## Getting started

Two steps, no Node on the host. Grab the
[`docker-compose.yaml`](https://github.com/avajadi/excalidraw-mcp/blob/main/docker-compose.yaml)
and start the persistent relay (it serves the live canvas at `localhost:3030` and survives
across sessions):

```bash
docker compose up -d
```

Then register the MCP — the same image, run per session over stdio — with Claude:

```bash
claude mcp add excalidraw -- \
  docker run -i --rm --network excalidraw \
  -e EXCALIDRAW_RELAY_URL=http://relay:3030 \
  avajadi/excalidraw-mcp-relay:1.3.0 mcp
```

Open <http://localhost:3030/> and ask Claude to draw — the diagram appears live on the canvas.

## Supported tags

- `latest` — newest build from `main`
- `X.Y.Z` — the `package.json` version (e.g. `1.3.0`), tagged on every `main` push
- `main` — the latest `main` build
- `sha-<commit>` — a specific commit
- `X.Y` / `X.Y.Z` semver — only produced when a `v*` git tag is pushed (none yet)

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

| Variable                | Default      | Description                                                                                                                                                          |
| ----------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_PORT`            | `3030`       | Port the relay listens on (also the exposed port).                                                                                                                  |
| `EXCALIDRAW_OUTPUT_DIR` | `/data`      | Where scenes and exported PNG/SVG images are written.                                                                                                               |
| `EXCALIDRAW_HOST_DIR`   | _(unset)_    | Host path that `/data` is mounted from. Set it to make the relay report host-absolute file paths to the MCP (a container can't discover its own bind-mount source). |
| `NODE_ENV`              | `production` | Node runtime mode.                                                                                                                                                 |

- **Volume:** `/data` holds saved scenes and any images exported via `export_scene` — mount a named volume to keep them across restarts.
- **Healthcheck:** built in; polls `GET /scenes` and reports `healthy` once the relay responds.

## Connecting the MCP server

Run the MCP straight from this image (no Node on the host). With the relay started via
`docker compose up -d` (it joins the `excalidraw` network), register the `mcp` role:

```bash
claude mcp add excalidraw -- \
  docker run -i --rm --network excalidraw \
  -e EXCALIDRAW_RELAY_URL=http://relay:3030 \
  avajadi/excalidraw-mcp-relay mcp
```

`--network excalidraw` joins the relay's network; `relay:3030` is the relay container's
hostname on it. The MCP container is throwaway (one per session); the relay stays alive and
keeps your canvas. Prefer running the MCP on the host instead? Point it at the published port:

```bash
claude mcp add excalidraw \
  --env EXCALIDRAW_RELAY_URL=http://localhost:3030 \
  -- node /absolute/path/to/excalidraw-mcp/dist/index.js
```

See the [project README](https://github.com/avajadi/excalidraw-mcp) for full usage.

## License

[Apache License 2.0](https://github.com/avajadi/excalidraw-mcp/blob/main/LICENSE).