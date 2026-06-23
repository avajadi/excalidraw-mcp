# Changelog

All notable changes to this project are documented here, newest first. The
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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