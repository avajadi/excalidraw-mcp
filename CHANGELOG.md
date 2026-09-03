# Changelog

All notable changes to this project are documented here, newest first. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## 2.0.0-rc1 - 2026-09-03

### Added

- The relay now serves MCP **directly over HTTP**, at `POST/GET/DELETE /mcp` (Streamable
  HTTP, stateless — a fresh `McpServer` per request, since every tool call already fetches
  scene state fresh; no session bookkeeping needed). Register it with:
  `claude mcp add --transport http excalidraw http://localhost:3030/mcp`. This is now the
  primary way to connect Claude — no Node on the host, no per-session container spawn.
- The tool set moved into a shared `src/mcp-tools.ts` (`createServer(relayUrl)`), used by
  both the new `/mcp` route and the existing stdio server (`src/index.ts`, still available
  for running on the host, or pure file-mode with no relay).

### Removed (breaking)

- The Docker image's `mcp` role is gone: `docker run <image> mcp` no longer starts a stdio
  MCP server — it now just tries (and fails) to exec a command named `mcp`. It existed only
  to bridge Docker → stdio → HTTP-to-relay, which is now redundant now that the relay speaks
  MCP natively. Along with it: the image `HEALTHCHECK`'s role-detection workaround (added in
  1.3.1), and the `excalidraw` Docker network in `docker-compose.yaml` (it existed solely so
  an `mcp`-role container could reach the relay by hostname).
- If you have `docker run ... avajadi/excalidraw-mcp-relay mcp` registered anywhere, switch
  it to `claude mcp add --transport http excalidraw http://localhost:3030/mcp` (or, to keep
  using stdio, run `dist/index.js` directly — see the README).

### Changed

- `@modelcontextprotocol/sdk` dependency floor raised to `^1.29.0` (from `^1.12.0`), the
  version this was built and tested against — it's what ships `StreamableHTTPServerTransport`.

## 1.4.0 - 2026-09-03

### Added

- `describe_scene` now reports style: `stroke`, `bg`, and non-default
  `strokeStyle`/`strokeWidth`/`fillStyle`/`roughness`/`fontSize`/arrowheads, plus
  a bound label's own `labelColor`/`labelFontSize`. Previously it emitted
  geometry only, so an agent couldn't read back what `update_element` had
  written, or restyle a drawing coherently, without opening the raw JSON.
- `update_element` and `delete_element` accept `ids: string[]` (alongside the
  existing single `id`) to apply the same patch, or delete several elements, in
  one call instead of one round trip per element.
- New tool `update_where` — restyle every element whose *current* properties
  match a filter (e.g. every element with a given `strokeColor`) in one call, a
  direct replacement for scripting a bulk edit into the `.excalidraw` file by
  hand.
- New tool `reload_scene` and relay endpoint `POST /scene/:id/reload` — re-reads
  a scene's `.excalidraw` file from disk into the relay and every open browser
  tab. For picking up an edit made outside this MCP server (a human hand-editing
  the file, or another tool exporting into it) without silently losing it on the
  next sync — the disk read happens inside the relay process, not via the MCP.

### Changed

- `list_scenes`, `current_scene`, and the `create_scene`/`add_elements`/
  `update_element`/`delete_element`/`update_where` responses no longer report a
  host-absolute file path when a relay is configured (this partly reverses the
  host-path reporting added in 1.3.0). Handing the MCP client the file's real
  path was an invitation to read or edit the live scene directly on disk instead
  of through the tools, which raced the relay's own writes and could silently
  discard edits made either way. File-mode (no relay) is unaffected — there is
  no browser to sync to, so the written path is the actual deliverable for a
  human to open.

## 1.3.1 - 2026-06-23

### Fixed

- The `mcp` (stdio) role no longer reports Docker health as **unhealthy**. The
  image healthcheck probes the relay's HTTP port, which the mcp role doesn't
  serve, so a working mcp container was always marked unhealthy. The entrypoint
  now records its role and the healthcheck reports the mcp role healthy as soon
  as it is running. The documented `docker run` for the mcp role also passes
  `--no-healthcheck`, which fixes it on already-published images too.

## 1.3.0 - 2026-06-23

### Added

- `export_scene` gained a `background` option (default `true`) — set `false` for
  a transparent PNG / no background rectangle in the SVG, matching the background
  toggle in Excalidraw's Export image dialog.
- Host-path reporting: set `EXCALIDRAW_HOST_DIR` on the relay (the host path its
  output dir is mounted from) and it reports **host-absolute** file paths via a
  new `GET /hostdir` endpoint. `export_scene`, `list_scenes`, `current_scene`,
  and the create/add/update tools now surface the real path you can open on the
  host instead of the in-container `/data` path.

### Changed

- `list_scenes` now sources its listing from the relay (via `GET /scenes`) when
  one is configured, instead of reading the MCP server's own output dir — the
  per-session MCP container never had the scenes mounted.

## 1.2.0 - 2026-06-23

### Added

- `export_scene` MCP tool — renders a scene to **PNG or SVG** using the browser's
  own exporter (the same path as Excalidraw's "Export image" menu), writes the
  image next to the `.excalidraw` file, and returns it. Accepts an optional
  `format` (`png` | `svg`) and `scale` (PNG resolution multiplier).
- Relay endpoint `POST /scene/:id/export` and an `export` / `exported` /
  `exportError` WebSocket round-trip (correlated by request id, 20s timeout) so
  the relay can ask a connected browser tab to render a scene and stream the
  bytes back.

### Notes

- Exporting requires a relay **and** a browser tab viewing the scene — image
  rendering needs a canvas and fonts, which only exist in the browser. With no
  relay or no open tab, the export fails with a message telling you to open it.
- Existing relays must be restarted and browser tabs reloaded to pick up the new
  WebSocket protocol.

## 1.1.0 - 2026-06-22

### Added

- Dual-role Docker image: one image runs either the long-lived `relay`
  (web canvas + WebSocket bridge, default) or the per-session `mcp` server over
  stdio, so the MCP can run in Docker instead of on the host.

## 1.0.1 - 2026-06-22

### Changed

- Updated the Node base image to the current LTS.

## 1.0.0 - 2026-06-18

### Added

- Initial release: an MCP server that turns high-level shape specs into
  Excalidraw scenes, with tools `create_scene`, `add_elements`,
  `update_element`, `delete_element`, `describe_scene`, `list_scenes`,
  `read_scene`, and `current_scene`.
- Live relay + companion web canvas with bidirectional, id-keyed merge editing,
  so Claude and the browser can co-edit the same drawing in real time.
- Bound arrows clipped to shape borders, and boxes that grow to fit their labels
  so text no longer clips.
- Docker packaging for the relay and a GitHub Actions workflow that publishes the
  image to Docker Hub.