# excalidraw-mcp

A file-based [MCP](https://modelcontextprotocol.io) server that turns natural-language
prompts into [Excalidraw](https://excalidraw.com) diagrams. You describe a diagram to
Claude, this server generates a valid `.excalidraw` JSON file, and you open it in your
(self-hosted, Dockerized) Excalidraw instance.

This is the simple, robust integration: no changes to Excalidraw itself, no collab
protocol — just generated files dropped into a directory you can open.

## How it works

Excalidraw scenes are JSON arrays of `elements` (rectangles, ellipses, arrows, text…).
The server exposes tools that take a *simplified* shape spec and expand each shape into
the verbose element object Excalidraw expects. Fields we omit (fractional indices, exact
binding geometry) are recomputed by Excalidraw on import, so output stays valid.

## Tools

- **`create_scene`** — `{ filename, elements[], viewBackgroundColor? }` → writes a `.excalidraw` file.
- **`list_scenes`** — lists generated files.
- **`read_scene`** — `{ filename }` → returns a file's raw JSON.

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

## Example prompt

> "Draw a login flow: a 'User' box, an arrow to an 'Auth Service' box, an arrow to a
> 'Database' box, and a dashed arrow back from Database to User labeled 'token'."

Claude calls `create_scene` with the shapes; you open the resulting file in Excalidraw.
