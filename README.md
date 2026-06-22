# excalidraw-mcp

A [MCP](https://modelcontextprotocol.io) server that turns natural-language prompts into
[Excalidraw](https://excalidraw.com) diagrams. You describe a diagram to Claude and the
server generates valid `.excalidraw` JSON.

It normally runs in **live mode**: point the server at the bundled **relay** and open the
**companion web app** in your browser. Scenes Claude draws appear on the canvas instantly,
you and Claude can co-edit the same drawing, and you can pick which saved scene to work on
from the canvas. This is the intended setup — see [Live view](#live-view), usually run via
[Docker](#docker-relay--web).

If no relay is configured the server falls back to **file mode**: it just writes a
`.excalidraw` file you open yourself — simple and robust, but with no live canvas and no
co-editing.

## Getting started

The published image ([`avajadi/excalidraw-mcp-relay`](https://hub.docker.com/r/avajadi/excalidraw-mcp-relay))
runs both roles, so the whole setup is two steps and no Node on the host. First start the
persistent relay with the [`docker-compose.yaml`](docker-compose.yaml) in this repo (it serves
the live canvas at `localhost:3030` and survives across sessions):

```bash
docker compose up -d
```

Then register the MCP — the same image, run per session over stdio — with Claude:

```bash
claude mcp add excalidraw -- \
  docker run -i --rm --network excalidraw \
  -e EXCALIDRAW_RELAY_URL=http://relay:3030 \
  avajadi/excalidraw-mcp-relay mcp
```

Open `http://localhost:3030/` and ask Claude to draw — the diagram appears live on the canvas.

## How it works

Excalidraw scenes are JSON arrays of `elements` (rectangles, ellipses, arrows, text…).
The server exposes tools that take a *simplified* shape spec and expand each shape into
the verbose element object Excalidraw expects. Fields we omit (fractional indices, exact
binding geometry) are recomputed by Excalidraw on import, so output stays valid.

## Tools

- **`create_scene`** — `{ filename, elements[], viewBackgroundColor? }` → creates a NEW scene, replacing any with that name.
- **`add_elements`** — `{ filename, elements[] }` → adds shapes to an existing scene **without disturbing** what's already there (including anything you drew by hand). New arrows may bind to existing element ids. Returns the created ids.
- **`update_element`** — `{ filename, id, patch }` → changes one element's style, label/text, and/or position & size. Moving or resizing recenters its label and reroutes bound arrows.
- **`delete_element`** — `{ filename, id }` → deletes one element, cascading its label and any arrows bound to it.
- **`describe_scene`** — `{ filename }` → compact, id-focused list of the current elements (reflects live browser edits) so Claude can target them.
- **`current_scene`** — `{}` → reports which scene the user has open in the browser (set by the scene picker or by following Claude's drawing).
- **`list_scenes`** — lists generated files.
- **`read_scene`** — `{ filename }` → returns the scene's raw JSON.

`add_elements` / `update_element` / `delete_element` apply id-keyed merge ops rather than replacing the scene, so Claude and the browser can co-edit the same drawing. These go to the relay via `POST /scene/:id/ops`; in the file-mode fallback the same merge is applied directly to the `.excalidraw` file.

The `filename` argument is **optional** on every scene tool: omit it and the tool acts on whatever scene the browser currently has open. The relay tracks this (the browser is the source of truth, via `GET /current`), so opening a scene with the picker is enough for Claude to work on "the current scene" — no need to name it.

### Element spec

| field | applies to | notes |
|-------|-----------|-------|
| `type` | all | `rectangle` \| `ellipse` \| `diamond` \| `text` \| `arrow` \| `line` |
| `id` | all | needed if an arrow binds to the shape |
| `x`, `y` | all | top-left position (default 0) |
| `width`, `height` | box shapes | default 160 × 80 |
| `text` | `text` | text content |
| `label` | box shapes | centered text bound inside the shape |
| `strokeColor`, `backgroundColor`, `fillStyle`, `strokeWidth`, `strokeStyle`, `roughness` | all | styling |
| `fontSize` | text/label | default 20 |
| `startId`, `endId` | arrow/line | bind ends to shape ids |
| `x2`, `y2` | arrow/line | explicit end point when not bound |
| `startArrowhead`, `endArrowhead` | arrow/line | `arrow` \| `triangle` \| `dot` \| `bar` \| `none` |

## Build

```bash
cd excalidraw-mcp
npm install
npm run build
```

## Register with Claude Code

Start the relay first (see [Live view](#live-view), or [Docker](#docker-relay--web) for the
usual path), then register the server pointing at it with `EXCALIDRAW_RELAY_URL`:

```bash
claude mcp add excalidraw \
  --env EXCALIDRAW_RELAY_URL=http://localhost:3030 \
  -- node /absolute/path/to/excalidraw-mcp/dist/index.js
```

Or in an MCP JSON config:

```json
{
  "mcpServers": {
    "excalidraw": {
      "command": "node",
      "args": ["/absolute/path/to/excalidraw-mcp/dist/index.js"],
      "env": { "EXCALIDRAW_RELAY_URL": "http://localhost:3030" }
    }
  }
}
```

**File-mode fallback:** omit `EXCALIDRAW_RELAY_URL` and the server writes `.excalidraw`
files to `EXCALIDRAW_OUTPUT_DIR` (default `./scenes`) that you open yourself — no live
canvas. In this mode point `EXCALIDRAW_OUTPUT_DIR` at a folder you can reach (e.g. one
mounted into your Excalidraw container). In live mode the relay owns the output directory,
so the MCP server doesn't need it.

## Live view

Live mode adds two pieces:

- a long-lived **relay** (`dist/relay.js`) that holds each scene in memory, persists it to
  the same `.excalidraw` files, and pushes updates over WebSocket; and
- a **companion web app** (`web/`) that embeds the real Excalidraw editor and connects to
  the relay.

The relay is a *separate, always-on process* — the MCP server is spawned per Claude
session and is ephemeral, so it can't host the browser connection itself. The MCP server
just `POST`s scenes to the relay when `EXCALIDRAW_RELAY_URL` is set; with it unset it falls
back to writing files exactly as before.

```
Claude ─stdio─▶ MCP server ─HTTP─▶ relay ─WebSocket─▶ browser (companion app)
                                     ▲                    │
                                     └──── edits back ◀───┘   (also written to .excalidraw)
```

### Build and run

```bash
npm install && npm run build   # build the MCP server + relay
npm run build:web              # install + build the companion app into web/dist

# start the relay (keep it running; serves the app and the scene API)
EXCALIDRAW_OUTPUT_DIR=/path/to/your/scenes RELAY_PORT=3030 npm run relay
```

Then register the MCP server pointing at the relay:

```bash
claude mcp add excalidraw \
  --env EXCALIDRAW_OUTPUT_DIR=/path/to/your/scenes \
  --env EXCALIDRAW_RELAY_URL=http://localhost:3030 \
  -- node /absolute/path/to/excalidraw-mcp/dist/index.js
```

Open `http://localhost:3030/` once in your browser. Whenever Claude draws, the relay tells
the open tab to **follow** that scene automatically — it switches to the scene being drawn
and updates its own URL, so you don't have to open `?scene=<name>` by hand. (You can still
open a specific scene directly with `?scene=<name>`, where `<name>` matches the `filename`
given to `create_scene`.) The canvas updates in place, keeping your viewport and selection.
Move shapes in the browser and `read_scene` returns the updated geometry.

Relay env vars: `RELAY_PORT` (default `3030`) and `EXCALIDRAW_OUTPUT_DIR` (where scenes are
persisted). In relay mode the MCP server talks to the relay over HTTP and never writes
files itself, so only the relay needs the output directory.

### Docker (relay + web)

The relay and the companion app are one process, so they ship as **one image** (built by
the included multi-stage `Dockerfile`). The MCP server is *not* containerized as a service —
Claude spawns it on the host over stdio and it reaches the relay over the published port.

```bash
# build + start the relay (serves the web app on http://localhost:3030)
docker compose up -d --build

# …or without compose:
docker build -t excalidraw-mcp-relay .
docker run -d --name excalidraw-relay \
  -p 127.0.0.1:3030:3030 \
  -v excalidraw-scenes:/data \
  excalidraw-mcp-relay
```

Scenes persist in the `excalidraw-scenes` named volume (mounted at `/data`, the container's
`EXCALIDRAW_OUTPUT_DIR`). To use a host directory instead, swap the volume for a bind mount,
e.g. `-v /path/to/scenes:/data`.

Then point the (host-side) MCP server at the container and register it with Claude:

```bash
claude mcp add excalidraw \
  --env EXCALIDRAW_RELAY_URL=http://localhost:3030 \
  -- node /absolute/path/to/excalidraw-mcp/dist/index.js
```

Open `http://localhost:3030/` and use it exactly as above. The compose file binds the port
to `127.0.0.1` because the scene API and WebSocket are **unauthenticated** — if you expose
the relay beyond localhost, put an authenticating TLS proxy in front of it.

To verify the container is up: `curl localhost:3030/scenes` returns a JSON list (`[]` when
empty); `docker compose logs -f relay` shows the startup line and the output dir.

#### Running the MCP in Docker too (no Node on the host)

The published image ships **both** roles: `relay` (the default) and `mcp`. So if you'd rather
not run Node on the host, you don't need a second image — register the same image as the MCP
with the `mcp` argument. It runs per-session over stdio and connects to the long-lived relay
container; the relay (and your live canvas) keeps running between sessions.

With the relay started via `docker compose up -d` (it joins the `excalidraw` network):

```bash
claude mcp add excalidraw -- \
  docker run -i --rm --network excalidraw \
  -e EXCALIDRAW_RELAY_URL=http://relay:3030 \
  avajadi/excalidraw-mcp-relay mcp
```

`--network excalidraw` joins the relay's network; `relay:3030` is the relay container's
hostname on it. The MCP container is throwaway (one per session); the relay is the persistent
one that keeps your canvas alive.

## Example prompt

> "Draw a login flow: a 'User' box, an arrow to an 'Auth Service' box, an arrow to a
> 'Database' box, and a dashed arrow back from Database to User labeled 'token'."

Claude calls `create_scene` and the diagram appears live on your open canvas (or, in the
file-mode fallback, is written as a `.excalidraw` file you open yourself).

## License

Licensed under the [Apache License 2.0](LICENSE).
