/**
 * Scene merge primitives shared by the relay and the MCP server.
 *
 * A scene is the verbose Excalidraw JSON; the only structure we rely on is that
 * every element has a stable string `id`. Edits are expressed as id-keyed `Op`s
 * so Claude and the browser can co-edit one scene without clobbering each other:
 * an upsert adds-or-replaces a single element, a delete removes one. Untouched
 * elements (including ones drawn by hand in the browser) always survive.
 */

export type Element = Record<string, unknown> & { id: string };
export type Scene = Record<string, unknown> & { elements?: Element[] };

export type Op =
  | { type: "upsert"; element: Element }
  | { type: "delete"; id: string };

/** A blank scene, used when an id is edited before it has ever been created. */
export function emptyScene(viewBackgroundColor = "#ffffff"): Scene {
  return {
    type: "excalidraw",
    version: 2,
    source: "excalidraw-mcp",
    elements: [],
    appState: { gridSize: null, viewBackgroundColor },
    files: {},
  };
}

/**
 * Apply id-keyed ops to a scene, returning a new scene. Upserting an element
 * that already exists keeps its original z-order position; brand-new elements
 * are appended (drawn on top). Deletes drop the element entirely.
 */
export function applyOps(scene: Scene, ops: Op[]): Scene {
  const byId = new Map<string, Element>();
  for (const el of scene.elements ?? []) byId.set(el.id, el);
  for (const op of ops) {
    if (op.type === "upsert") byId.set(op.element.id, op.element);
    else byId.delete(op.id);
  }
  return { ...scene, elements: [...byId.values()] };
}