# excalidraw-mcp

A [MCP](https://modelcontextprotocol.io) server that turns natural-language prompts into
[Excalidraw](https://excalidraw.com) diagrams. You describe a diagram to Claude and the
server generates valid `.excalidraw` JSON.

It runs in one of two modes:

- **File mode (default).** The server writes a `.excalidraw` file you open in your
  (self-hosted, Dockerized) Excalidraw instance. Simple and robust — no changes to
  Excalidraw, no collab protocol.
- **Live mode.** Point the server at the bundled **relay** and open the **companion web
  app** in your browser: scenes Claude draws appear on the canvas instantly, and edits you
  make in the browser flow back so `read_scene` reflects them. See
  [Live view](#live-view).

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

`add_elements` / `update_element` / `delete_element` apply id-keyed merge ops rather than replacing the scene, so Claude and the browser can co-edit the same drawing. With a relay configured these go to `POST /scene/:id/ops`; in file-only mode the same merge is applied to the `.excalidraw` file.

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

```bash
claude mcp add excalidraw \
  --env EXCALIDRAW_OUTPUT_DIR=/path/to/your/scenes \
  -- node /absolute/path/to/excalidraw-mcp/dist/index.js
```

Or in an MCP JSON config:

```json
{
  "mcpServers": {
    "excalidraw": {
      "command": "node",
      "args": ["/absolute/path/to/excalidraw-mcp/dist/index.js"],
      "env": { "EXCALIDRAW_OUTPUT_DIR": "/path/to/your/scenes" }
    }
  }
}
```

`EXCALIDRAW_OUTPUT_DIR` defaults to `./scenes` relative to the server's working
directory. Point it at a host folder you can reach — ideally one you've mounted into
your Excalidraw Docker container, or just a local folder you open files from.

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

Relay env vars: `RELAY_PORT` (default `3030`) and `EXCALIDRAW_OUTPUT_DIR` (shared with the
MCP server — both must point at the same directory). The relay and app are a single
process, so you can run them in one container next to your existing Excalidraw deployment.

## Example prompt

> "Draw a login flow: a 'User' box, an arrow to an 'Auth Service' box, an arrow to a
> 'Database' box, and a dashed arrow back from Database to User labeled 'token'."

Claude calls `create_scene` with the shapes; you open the resulting file in Excalidraw.
