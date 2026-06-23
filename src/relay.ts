#!/usr/bin/env node
/**
 * Long-lived relay for live Excalidraw viewing.
 *
 * - The MCP server POSTs full scenes here (keyed by scene id / filename).
 * - Browsers running the companion app subscribe over WebSocket per scene.
 * - The relay holds the current scene in memory, persists it to a `.excalidraw`
 *   file (durable backup, keeps the file-based tools working), and broadcasts
 *   every change to the other connected clients.
 *
 * It is a *separate* process from the MCP server: the MCP server is spawned per
 * Claude session and is ephemeral, while a browser connection must outlive it.
 */
import * as http from "node:http";
import { promises as fs, createReadStream } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { OUTPUT_DIR, sceneId, resolveScenePath } from "./paths.js";
import { applyOps, emptyScene, type Op, type Scene } from "./scene.js";

const PORT = Number(process.env.RELAY_PORT ?? 3030);
const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "dist");

/**
 * Where OUTPUT_DIR is mounted on the host. A container can't discover its own
 * bind-mount source, so when the relay runs in Docker this must be supplied
 * (e.g. EXCALIDRAW_HOST_DIR=/home/me/Pictures/excalidraw/scenes) for the relay
 * to report host-absolute file paths back to the MCP. Unset → report the path
 * as the relay sees it (the in-container /data path, or the real path on host).
 */
const HOST_DIR = process.env.EXCALIDRAW_HOST_DIR?.replace(/\/+$/, "");

/** Translate an OUTPUT_DIR path to its host-filesystem equivalent (see HOST_DIR). */
function hostPath(internal: string): string {
  return HOST_DIR ? path.join(HOST_DIR, path.relative(OUTPUT_DIR, internal)) : internal;
}

/** Current scene JSON per id. */
const scenes = new Map<string, Scene>();
/** Every open browser socket → the scene id it is currently viewing. */
const socketScene = new Map<WebSocket, string>();
/**
 * The scene the browser currently has loaded — the source of truth for "the
 * current scene", set only by browser actions (opening, switching, editing) so
 * the MCP can act on whatever the user is looking at. Claude's own pushes do
 * not change it; the browser confirms what it is showing via a `viewing` message.
 */
let currentSceneId: string | null = null;

/**
 * A rendered image returned by a browser tab — PNG comes back base64-encoded,
 * SVG as the markup string.
 */
interface ExportResult {
  format: "png" | "svg";
  encoding: "base64" | "utf8";
  data: string;
}

/**
 * Image export is done by the browser (the only place with a canvas + fonts), so
 * the relay asks a connected tab to render and waits for the reply. Each request
 * is keyed by a random id the tab echoes back, so concurrent exports don't cross.
 */
const pendingExports = new Map<
  string,
  { resolve: (r: ExportResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

const EXPORT_TIMEOUT_MS = 20000;

/** First open socket currently viewing `id`, or null if no tab has it loaded. */
function socketViewing(id: string): WebSocket | null {
  for (const [ws, sid] of socketScene) {
    if (sid === id && ws.readyState === WebSocket.OPEN) return ws;
  }
  return null;
}

/** Ask a browser tab to render `id` and resolve with the image it sends back. */
function requestExport(
  ws: WebSocket,
  id: string,
  opts: { format: "png" | "svg"; scale?: number; background?: boolean },
): Promise<ExportResult> {
  const requestId = randomUUID();
  return new Promise<ExportResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingExports.delete(requestId);
      reject(new Error("Browser export timed out (is the tab still open?)"));
    }, EXPORT_TIMEOUT_MS);
    pendingExports.set(requestId, { resolve, reject, timer });
    ws.send(JSON.stringify({ type: "export", id, requestId, ...opts }));
  });
}

function broadcast(msg: unknown, accept: (ws: WebSocket) => boolean): void {
  const payload = JSON.stringify(msg);
  for (const ws of socketScene.keys()) {
    if (ws.readyState === WebSocket.OPEN && accept(ws)) ws.send(payload);
  }
}

/** Load a scene into memory, falling back to the on-disk copy if present. */
async function loadScene(id: string): Promise<Scene | null> {
  const cached = scenes.get(id);
  if (cached) return cached;
  try {
    const data = await fs.readFile(resolveScenePath(id), "utf8");
    const scene = JSON.parse(data) as Scene;
    scenes.set(id, scene);
    return scene;
  } catch {
    return null;
  }
}

/**
 * Names of every scene in the output dir, for the companion app's scene picker.
 * Includes scenes only held in memory but not yet flushed (there shouldn't be
 * any, but it keeps the list complete).
 */
async function listScenes(): Promise<Array<{ id: string; name: string }>> {
  const ids = new Set<string>(scenes.keys());
  try {
    for (const f of await fs.readdir(OUTPUT_DIR)) {
      if (f.endsWith(".excalidraw")) ids.add(f);
    }
  } catch {
    // output dir not created yet
  }
  return [...ids]
    .sort()
    .map((id) => ({ id, name: id.replace(/\.excalidraw$/, "") }));
}

/**
 * Store a scene, persist it to disk, and push it to browsers.
 *
 * `activate` makes every connected tab switch to (follow) this scene — used for
 * MCP pushes so the open canvas always shows what Claude is drawing, without the
 * user opening the right URL. Without it (a browser edit) the scene is only sent
 * to the other tabs already viewing it, so editing one scene never yanks others.
 */
async function setScene(
  id: string,
  scene: Scene,
  opts: { activate?: boolean; from?: WebSocket } = {},
): Promise<void> {
  scenes.set(id, scene);
  try {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await fs.writeFile(resolveScenePath(id), JSON.stringify(scene, null, 2), "utf8");
  } catch (err) {
    console.error(`Failed to persist scene ${id}:`, err);
  }

  if (opts.activate) {
    for (const ws of socketScene.keys()) {
      if (ws !== opts.from) socketScene.set(ws, id); // they now view this scene
    }
    broadcast({ type: "scene", id, scene, activate: true }, (ws) => ws !== opts.from);
  } else {
    broadcast(
      { type: "scene", id, scene },
      (ws) => ws !== opts.from && socketScene.get(ws) === id,
    );
  }
}

// ---------------------------------------------------------------------------
// HTTP: scene API for the MCP server + static hosting for the companion app
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

/** Serve a file from web/dist, falling back to index.html for client routing. */
async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
  let rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  let file = path.join(WEB_DIR, rel);
  // Contain within WEB_DIR; fall back to the SPA entry for unknown routes.
  if (!file.startsWith(WEB_DIR) || !(await exists(file))) {
    file = path.join(WEB_DIR, "index.html");
  }
  if (!(await exists(file))) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Companion app not built. Run: npm run build:web");
    return;
  }
  res.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const opsMatch = url.pathname.match(/^\/scene\/(.+)\/ops$/);
    const exportMatch = url.pathname.match(/^\/scene\/(.+)\/export$/);
    const sceneMatch = url.pathname.match(/^\/scene\/(.+)$/);

    // Incremental, non-destructive edits: apply id-keyed ops to the live scene
    // and broadcast the merged result. This is how Claude co-edits a scene the
    // user may also be editing in the browser.
    if (opsMatch && req.method === "POST") {
      const id = sceneId(decodeURIComponent(opsMatch[1]));
      const { ops, activate } = JSON.parse(await readBody(req)) as {
        ops: Op[];
        activate?: boolean;
      };
      const current = (await loadScene(id)) ?? emptyScene();
      const merged = applyOps(current, ops);
      await setScene(id, merged, { activate: activate ?? true });
      sendJson(res, 200, { ok: true, id, elements: merged.elements?.length ?? 0 });
      return;
    }

    // Image export: have a browser tab render the scene (same path as the Export
    // image menu), write the result next to the .excalidraw backup, and return it.
    if (exportMatch && req.method === "POST") {
      const id = sceneId(decodeURIComponent(exportMatch[1]));
      const { format = "png", scale, background = true } = JSON.parse(await readBody(req)) as {
        format?: "png" | "svg";
        scale?: number;
        background?: boolean;
      };
      const target = socketViewing(id);
      if (!target) {
        sendJson(res, 409, {
          error:
            `No browser tab is viewing '${id}'. Open ` +
            `/?scene=${encodeURIComponent(id)} in the companion app and retry.`,
        });
        return;
      }
      try {
        const result = await requestExport(target, id, { format, scale, background });
        const outPath = resolveScenePath(id).replace(/\.excalidraw$/, `.${result.format}`);
        const buf =
          result.encoding === "base64"
            ? Buffer.from(result.data, "base64")
            : Buffer.from(result.data, "utf8");
        await fs.mkdir(OUTPUT_DIR, { recursive: true });
        await fs.writeFile(outPath, buf);
        sendJson(res, 200, { ok: true, ...result, path: hostPath(outPath) });
      } catch (err) {
        sendJson(res, 504, { error: String(err) });
      }
      return;
    }

    // Scene picker: list every scene the user can open and work on.
    if (url.pathname === "/scenes" && req.method === "GET") {
      sendJson(res, 200, await listScenes());
      return;
    }

    // The scene the browser currently has loaded, so the MCP can act on it.
    if (url.pathname === "/current" && req.method === "GET") {
      sendJson(res, 200, { id: currentSceneId });
      return;
    }

    // The host-filesystem directory where scenes/exports land, so the MCP can
    // report absolute paths the user can actually open (see HOST_DIR).
    if (url.pathname === "/hostdir" && req.method === "GET") {
      sendJson(res, 200, { dir: HOST_DIR ?? OUTPUT_DIR });
      return;
    }

    if (sceneMatch) {
      const id = sceneId(decodeURIComponent(sceneMatch[1]));
      if (req.method === "POST") {
        const scene = JSON.parse(await readBody(req)) as Scene;
        // MCP push → activate so any open tab follows the scene Claude is drawing.
        await setScene(id, scene, { activate: true });
        sendJson(res, 200, { ok: true, id, elements: scene.elements?.length ?? 0 });
        return;
      }
      if (req.method === "GET") {
        const scene = await loadScene(id);
        if (!scene) {
          sendJson(res, 404, { error: `No scene '${id}'` });
          return;
        }
        sendJson(res, 200, scene);
        return;
      }
      res.writeHead(405).end();
      return;
    }

    await serveStatic(req, res);
  } catch (err) {
    console.error("Request error:", err);
    sendJson(res, 500, { error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// WebSocket: per-scene live channel for the companion app
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server });

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  let id = sceneId(url.searchParams.get("scene") ?? "scene");
  socketScene.set(ws, id);
  currentSceneId = id;

  // Send the current scene (if any) so a freshly opened tab is in sync.
  const scene = await loadScene(id);
  if (scene && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "scene", id, scene }));
  }

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "update" && msg.scene) {
        // Browser edit → persist + fan out to other tabs on the same scene.
        id = msg.id ? sceneId(msg.id) : id;
        socketScene.set(ws, id);
        currentSceneId = id;
        void setScene(id, msg.scene as Scene, { from: ws });
      } else if (msg.type === "subscribe" && msg.id) {
        // Tab explicitly switched scene (e.g. user navigation).
        id = sceneId(msg.id);
        socketScene.set(ws, id);
        currentSceneId = id;
        void loadScene(id).then((s) => {
          if (s && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "scene", id, scene: s }));
          }
        });
      } else if (msg.type === "viewing" && msg.id) {
        // Tab reporting which scene it now shows (e.g. after following a push),
        // without needing the scene re-sent. Keeps "current scene" accurate.
        id = sceneId(msg.id);
        socketScene.set(ws, id);
        currentSceneId = id;
      } else if (msg.type === "exported" && msg.requestId) {
        // A tab finished rendering an export we asked for.
        const pending = pendingExports.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingExports.delete(msg.requestId);
          pending.resolve({ format: msg.format, encoding: msg.encoding, data: msg.data });
        }
      } else if (msg.type === "exportError" && msg.requestId) {
        const pending = pendingExports.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingExports.delete(msg.requestId);
          pending.reject(new Error(String(msg.error)));
        }
      }
    } catch (err) {
      console.error(`Bad message on scene ${id}:`, err);
    }
  });

  ws.on("close", () => socketScene.delete(ws));
  ws.on("error", () => socketScene.delete(ws));
});

server.listen(PORT, () => {
  console.log(`excalidraw relay on http://localhost:${PORT}  (output dir: ${OUTPUT_DIR})`);
  if (HOST_DIR) console.log(`Reporting host paths under: ${HOST_DIR}`);
  console.log(`Open a scene: http://localhost:${PORT}/?scene=<name>`);
});
