# excalidraw-mcp-relay

The live-view **relay** for [excalidraw-mcp](https://github.com/avajadi/excalidraw-mcp) — an
[MCP](https://modelcontextprotocol.io) server that turns natural-language prompts into
[Excalidraw](https://excalidraw.com) diagrams.

This image is the long-lived **relay**: it serves the companion web canvas, bridges scene
updates over WebSocket, and serves **MCP itself directly over HTTP** at `/mcp` — Claude
connects straight to it, no separate MCP process or container needed.

## Quick start

Two steps, no Node on the host, no second container.

**1. Start the relay.** It serves the live canvas at `localhost:3030` and survives across
sessions. Grab
[`docker-compose.yaml`](https://github.com/avajadi/excalidraw-mcp/blob/main/docker-compose.yaml)
and run:

```bash
docker compose up -d
```

**2. Register it with Claude** as an HTTP MCP server:

```bash
claude mcp add --transport http excalidraw http://localhost:3030/mcp
```

Open <http://localhost:3030/> and ask Claude to draw — the diagram appears live on the canvas.

**Prefer running the MCP server on the host over stdio instead?** (Requires a local checkout
with `npm run build`; see the [project README](https://github.com/avajadi/excalidraw-mcp).)

```bash
claude mcp add excalidraw \
  --env EXCALIDRAW_RELAY_URL=http://localhost:3030 \
  -- node /absolute/path/to/excalidraw-mcp/dist/index.js
```

## Supported tags

- `latest` — newest build from `main`
- `X.Y.Z` — the `package.json` version (e.g. `2.0.0-rc1`), tagged on every `main` push
- `main` — the latest `main` build
- `sha-<commit>` — a specific commit
- `X.Y` / `X.Y.Z` semver — only produced when a `v*` git tag is pushed (none yet)

Pin a `1.x` tag to keep using the pre-`2.0.0` two-role image — see
[Using a pre-2.0 image](#using-a-pre-20-image-the-docker-mcp-role) below.

## Using a pre-2.0 image (the Docker `mcp` role)

Starting with `2.0.0`, this image dropped the separate stdio `mcp` role: the relay now
serves MCP directly over HTTP at `/mcp` (see [Quick start](#quick-start) above), so the
extra per-session container isn't needed anymore.

While that new structure settles in — or if you have automation built around the old flow,
or a client that only speaks stdio — pin to a `1.x` tag (e.g. `1.4.0`, the last release
before the `mcp` role was removed) and keep using the old two-container setup:

```bash
docker network create excalidraw   # skip if it already exists

docker run -d --name relay --network excalidraw \
  -p 127.0.0.1:3030:3030 \
  -v excalidraw-scenes:/data \
  avajadi/excalidraw-mcp-relay:1.4.0

claude mcp add excalidraw -- \
  docker run -i --rm --no-healthcheck --network excalidraw \
  -e EXCALIDRAW_RELAY_URL=http://relay:3030 \
  avajadi/excalidraw-mcp-relay:1.4.0 mcp
```

- `--network excalidraw` lets the per-session `mcp` container reach the relay by name
  (`relay:3030` — the DNS name Docker gives a container on a user-defined network by its
  `--name`).
- `--no-healthcheck` is for the stdio `mcp` role: it has no HTTP port, so the pre-2.0
  image's relay healthcheck would otherwise mark a perfectly working container "unhealthy".

Everything else on this page — [Configuration](#configuration), `docker-compose`, host file
paths — works the same on `1.x`; only the MCP connection step differs. When you're ready to
move to `2.0.0`+, switch the `claude mcp add` line to
`claude mcp add --transport http excalidraw http://localhost:3030/mcp` and drop the `mcp`
container entirely.

## Supported architectures

`linux/amd64` and `linux/arm64`.

## Running the relay without compose

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

| Variable                | Default      | Description                                                                                                                              |
| ------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `RELAY_PORT`            | `3030`       | Port the relay listens on (also the exposed port).                                                                                       |
| `EXCALIDRAW_OUTPUT_DIR` | `/data`      | Where scenes and exported PNG/SVG images are written.                                                                                    |
| `EXCALIDRAW_HOST_DIR`   | _(unset)_    | Host path that `/data` is mounted from. Set it so `export_scene` reports a host-absolute image path (a container can't discover its own bind-mount source). |
| `NODE_ENV`              | `production` | Node runtime mode.                                                                                                                        |

- **Volume:** `/data` holds saved scenes and any images exported via `export_scene` — mount a named volume to keep them across restarts.
- **Healthcheck:** built in; polls `GET /scenes` and reports `healthy` once the relay responds.

## Host file paths (`EXCALIDRAW_HOST_DIR`)

By default the relay only knows its in-container path (`/data`), so a path it computes from
that — where `export_scene` just saved a PNG, say — looks like `/data/diagram.png`, which you
can't open from the host. To get a **host-absolute** path back from `export_scene`, bind-mount a
host directory **and** set `EXCALIDRAW_HOST_DIR` to that same host path (a container can't
discover its own bind-mount source, so you must tell it):

```bash
docker run -d \
  --name excalidraw-relay \
  -p 127.0.0.1:3030:3030 \
  --user "1000:1000" \
  -v /home/you/excalidraw/scenes:/data \
  -e EXCALIDRAW_HOST_DIR=/home/you/excalidraw/scenes \
  avajadi/excalidraw-mcp-relay:latest
```

Or in `docker-compose.yaml`:

```yaml
services:
  relay:
    image: avajadi/excalidraw-mcp-relay:latest
    container_name: excalidraw-relay
    user: "1000:1000"            # your uid:gid, so files stay yours
    ports:
      - "127.0.0.1:3030:3030"
    environment:
      RELAY_PORT: "3030"
      EXCALIDRAW_OUTPUT_DIR: /data
      EXCALIDRAW_HOST_DIR: /home/you/excalidraw/scenes  # == the host side of the mount
    volumes:
      - /home/you/excalidraw/scenes:/data
    restart: unless-stopped
```

Now `export_scene` reports paths like `/home/you/excalidraw/scenes/diagram.png` instead of the
in-container `/data/diagram.png`. Leave `EXCALIDRAW_HOST_DIR` unset (e.g. with a named volume)
and it falls back to the `/data` path — correct inside the container, just not something you can
open directly from the host shell. (The live `.excalidraw` scene itself is never read from or
written to by the MCP client directly, in either case — every scene edit goes through the MCP
tools, which talk to the relay over HTTP.)

## License

[Apache License 2.0](https://github.com/avajadi/excalidraw-mcp/blob/main/LICENSE).
