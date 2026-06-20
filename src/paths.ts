import * as path from "node:path";

/**
 * Where generated `.excalidraw` files live. Shared by the MCP server (writes when
 * no relay is configured) and the relay (persists live scene state as a backup).
 */
export const OUTPUT_DIR = process.env.EXCALIDRAW_OUTPUT_DIR
  ? path.resolve(process.env.EXCALIDRAW_OUTPUT_DIR)
  : path.join(process.cwd(), "scenes");

/**
 * Normalize a scene id / filename to a bare name (no path, `.excalidraw` suffix).
 * Used as the key under which a scene is stored and broadcast.
 */
export function sceneId(filename: string): string {
  let name = path.basename(filename.trim());
  if (!name) throw new Error("filename is empty");
  if (!name.endsWith(".excalidraw")) name += ".excalidraw";
  return name;
}

/** Resolve a user-supplied filename safely inside OUTPUT_DIR. */
export function resolveScenePath(filename: string): string {
  return path.join(OUTPUT_DIR, sceneId(filename));
}
