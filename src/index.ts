#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import {
  buildScene,
  buildAddDelta,
  buildUpdateDelta,
  buildUpdateWhereDelta,
  buildDeleteDelta,
  elementSchema,
  updatePatchSchema,
  matchPatchSchema,
  type ElementSpec,
} from "./excalidraw.js";
import { applyOps, emptyScene, type Op, type Scene } from "./scene.js";
import { OUTPUT_DIR, resolveScenePath, sceneId } from "./paths.js";

// When set (e.g. http://localhost:3030), scenes live in the long-lived relay for
// live viewing and co-editing. Unset = file-only mode (each scene is a file).
const RELAY_URL = process.env.EXCALIDRAW_RELAY_URL?.replace(/\/+$/, "");

/** URL a user can open in the companion app to watch a scene live. */
function liveUrl(id: string): string | null {
  return RELAY_URL ? `${RELAY_URL}/?scene=${encodeURIComponent(id)}` : null;
}

// ---------------------------------------------------------------------------
// Scene access — relay-backed when configured, otherwise on disk. Both paths
// share the same merge semantics so edits behave identically either way.
// ---------------------------------------------------------------------------

/** Read the current scene (incl. live browser edits when a relay is in use). */
async function getScene(id: string): Promise<Scene> {
  if (RELAY_URL) {
    const res = await fetch(`${RELAY_URL}/scene/${encodeURIComponent(id)}`);
    if (res.ok) return (await res.json()) as Scene;
    return emptyScene(); // 404: not created yet
  }
  try {
    return JSON.parse(await fs.readFile(resolveScenePath(id), "utf8")) as Scene;
  } catch {
    return emptyScene();
  }
}

/** Apply id-keyed ops to a scene, merging non-destructively. */
async function pushOps(id: string, ops: Op[]): Promise<void> {
  if (RELAY_URL) {
    const res = await fetch(`${RELAY_URL}/scene/${encodeURIComponent(id)}/ops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ops, activate: true }),
    });
    if (!res.ok) {
      throw new Error(`Relay rejected ops (${res.status}): ${await res.text()}`);
    }
    return;
  }
  const merged = applyOps(await getScene(id), ops);
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(resolveScenePath(id), JSON.stringify(merged, null, 2), "utf8");
}

/** The scene the browser currently has loaded, or null if none / no relay. */
async function currentSceneId(): Promise<string | null> {
  if (!RELAY_URL) return null;
  try {
    const res = await fetch(`${RELAY_URL}/current`);
    if (!res.ok) return null;
    const { id } = (await res.json()) as { id: string | null };
    return id;
  } catch {
    return null;
  }
}

/**
 * Resolve which scene a tool should act on: the explicit `filename` if given,
 * otherwise whatever the user currently has open in the browser.
 */
async function resolveScene(filename?: string): Promise<string> {
  if (filename) return sceneId(filename);
  const current = await currentSceneId();
  if (current) return current;
  throw new Error(
    RELAY_URL
      ? "No scene is currently loaded in the browser. Open one in the canvas, or pass `filename`."
      : "`filename` is required (no relay is configured to provide a current scene).",
  );
}

/** Where a scene ended up, for messages back to the user. */
async function whereText(id: string): Promise<string> {
  if (!RELAY_URL) {
    return `Wrote ${resolveScenePath(id)} — open it in Excalidraw to view/edit.`;
  }
  return `An open tab follows automatically; otherwise open: ${liveUrl(id)}.`;
}

const server = new McpServer({ name: "excalidraw", version: "1.0.0" });

server.tool(
  "create_scene",
  "Create a NEW Excalidraw drawing from a list of shapes, REPLACING any scene " +
    "with this name. Shapes: rectangle, ellipse, diamond, text, arrow, line. " +
    "Give box shapes an `id` and a `label`; connect them with arrows via " +
    "`startId`/`endId`. To add to or change an existing scene without wiping it, " +
    "use add_elements / update_element / delete_element instead.",
  {
    filename: z
      .string()
      .optional()
      .describe(
        "Output scene name, e.g. 'flowchart' (the .excalidraw suffix is added). " +
          "Omit to replace the scene currently open in the browser.",
      ),
    elements: z
      .array(elementSchema)
      .min(1)
      .describe("Shapes to draw, in z-order (earlier = behind)."),
    viewBackgroundColor: z
      .string()
      .optional()
      .describe("Canvas background color. Default '#ffffff'."),
  },
  async ({ filename, elements, viewBackgroundColor }) => {
    const scene = buildScene(elements as ElementSpec[], { viewBackgroundColor });
    const id = await resolveScene(filename);

    if (RELAY_URL) {
      const res = await fetch(`${RELAY_URL}/scene/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(scene),
      });
      if (!res.ok) {
        throw new Error(`Relay rejected scene (${res.status}): ${await res.text()}`);
      }
    } else {
      await fs.mkdir(OUTPUT_DIR, { recursive: true });
      await fs.writeFile(resolveScenePath(id), JSON.stringify(scene, null, 2), "utf8");
    }
    return {
      content: [
        {
          type: "text",
          text: `Created scene '${id}' with ${scene.elements.length} element(s). ${await whereText(id)}`,
        },
      ],
    };
  },
);

server.tool(
  "add_elements",
  "Add shapes to an existing scene WITHOUT disturbing what is already there " +
    "(including anything the user drew by hand). New arrows/lines may bind to " +
    "existing elements via `startId`/`endId` using their ids (see describe_scene). " +
    "Returns the ids of the elements created so you can target them later.",
  {
    filename: z
      .string()
      .optional()
      .describe("Scene to add to (created if missing). Omit to use the scene open in the browser."),
    elements: z.array(elementSchema).min(1).describe("Shapes to add."),
  },
  async ({ filename, elements }) => {
    const id = await resolveScene(filename);
    const scene = await getScene(id);
    const { ops, created } = buildAddDelta(elements as ElementSpec[], scene);
    await pushOps(id, ops);
    const list = created
      .map((c) => `  ${c.id}  (${c.type}${c.label ? `: ${c.label}` : c.text ? `: ${c.text}` : ""})`)
      .join("\n");
    return {
      content: [
        {
          type: "text",
          text: `Added ${created.length} element(s) to '${id}':\n${list}\n${await whereText(id)}`,
        },
      ],
    };
  },
);

server.tool(
  "update_element",
  "Change one or more existing elements by id: colors/style, label or text, " +
    "and/or position and size. The same patch is applied to every id. Moving or " +
    "resizing a shape recenters its label and reroutes any arrows bound to it. " +
    "Use describe_scene to find ids, or update_where to select by current style " +
    "instead of by id.",
  {
    filename: z
      .string()
      .optional()
      .describe("Scene containing the element(s). Omit to use the scene open in the browser."),
    id: z.string().optional().describe("Element id to change (from describe_scene)."),
    ids: z
      .array(z.string())
      .min(1)
      .optional()
      .describe("Multiple element ids to apply the same patch to. Use instead of `id`."),
    patch: updatePatchSchema.describe("Fields to change; omit what stays the same."),
  },
  async ({ filename, id, ids, patch }) => {
    const targets = ids ?? (id ? [id] : []);
    if (!targets.length) throw new Error("Provide `id` or `ids`.");
    const sid = await resolveScene(filename);
    const scene = await getScene(sid);
    const ops = targets.flatMap((t) => buildUpdateDelta(scene, t, patch));
    await pushOps(sid, ops);
    return {
      content: [
        {
          type: "text",
          text: `Updated ${targets.length} element(s) (${targets.join(", ")}) in '${sid}'. ${await whereText(sid)}`,
        },
      ],
    };
  },
);

server.tool(
  "delete_element",
  "Delete one or more elements by id. Deleting a shape also removes its label " +
    "and any arrows bound to it (which would otherwise dangle). Use describe_scene " +
    "for ids.",
  {
    filename: z
      .string()
      .optional()
      .describe("Scene containing the element(s). Omit to use the scene open in the browser."),
    id: z.string().optional().describe("Element id to delete (from describe_scene)."),
    ids: z
      .array(z.string())
      .min(1)
      .optional()
      .describe("Multiple element ids to delete at once. Use instead of `id`."),
  },
  async ({ filename, id, ids }) => {
    const targets = ids ?? (id ? [id] : []);
    if (!targets.length) throw new Error("Provide `id` or `ids`.");
    const sid = await resolveScene(filename);
    const scene = await getScene(sid);
    const ops = targets.flatMap((t) => buildDeleteDelta(scene, t));
    await pushOps(sid, ops);
    const removed = new Set(ops.filter((o) => o.type === "delete").map((o) => o.id)).size;
    return {
      content: [
        { type: "text", text: `Deleted ${removed} element(s) from '${sid}'. ${await whereText(sid)}` },
      ],
    };
  },
);

server.tool(
  "update_where",
  "Restyle every element whose CURRENT properties match `match`, in one call — " +
    "e.g. every element with strokeColor '#e03131' to strokeColor '#E83C63'. Use " +
    "this instead of update_element per id for palette swaps or other bulk " +
    "restyles. Matches the same elements describe_scene lists (no bound labels, " +
    "target their container's `label` field instead). Reports the ids it touched.",
  {
    filename: z
      .string()
      .optional()
      .describe("Scene to restyle. Omit to use the scene open in the browser."),
    match: matchPatchSchema.describe(
      "Current values elements must have to be selected. At least one field required.",
    ),
    patch: updatePatchSchema.describe("Fields to change on every matched element."),
  },
  async ({ filename, match, patch }) => {
    const sid = await resolveScene(filename);
    const scene = await getScene(sid);
    const { ops, ids } = buildUpdateWhereDelta(scene, match, patch);
    if (!ids.length) {
      return { content: [{ type: "text", text: `No elements matched in '${sid}'.` }] };
    }
    await pushOps(sid, ops);
    return {
      content: [
        {
          type: "text",
          text: `Updated ${ids.length} element(s) in '${sid}': ${ids.join(", ")}. ${await whereText(sid)}`,
        },
      ],
    };
  },
);

server.tool(
  "describe_scene",
  "List the current elements of a scene with their ids, so you can target them " +
    "with update_element / delete_element or bind new arrows to them. Reflects " +
    "live edits made in the browser. Bound text labels are folded into their shape.",
  {
    filename: z
      .string()
      .optional()
      .describe("Scene to describe. Omit to use the scene open in the browser."),
  },
  async ({ filename }) => {
    const id = await resolveScene(filename);
    const scene = await getScene(id);
    const els = (scene.elements ?? []) as Array<Record<string, unknown>>;
    const byId = new Map(els.map((e) => [e.id as string, e]));

    const summary = els
      // Skip tombstones (Excalidraw soft-deletes with isDeleted) and bound text
      // labels (folded into their shape below).
      .filter((e) => !e.isDeleted && !(e.type === "text" && e.containerId))
      .map((e) => {
        const row: Record<string, unknown> = {
          id: e.id,
          type: e.type,
          x: Math.round(e.x as number),
          y: Math.round(e.y as number),
          w: Math.round(e.width as number),
          h: Math.round(e.height as number),
        };
        row.stroke = e.strokeColor;
        row.bg = e.backgroundColor;
        if (e.strokeStyle !== "solid") row.strokeStyle = e.strokeStyle;
        if (e.strokeWidth !== 2) row.strokeWidth = e.strokeWidth;
        if (e.fillStyle !== "solid") row.fillStyle = e.fillStyle;
        if (e.roughness !== 1) row.roughness = e.roughness;
        if (e.type === "text") row.fontSize = e.fontSize;
        if (e.type === "arrow" || e.type === "line") {
          row.startArrowhead = e.startArrowhead ?? null;
          row.endArrowhead = e.endArrowhead ?? null;
        }
        if (e.type === "text") {
          row.text = e.text;
        } else if (e.type === "arrow" || e.type === "line") {
          row.from = (e.startBinding as { elementId: string } | null)?.elementId ?? null;
          row.to = (e.endBinding as { elementId: string } | null)?.elementId ?? null;
        } else {
          const lbl = ((e.boundElements ?? []) as Array<{ type: string; id: string }>).find(
            (b) => b.type === "text",
          );
          const lblEl = lbl ? byId.get(lbl.id) : undefined;
          if (lblEl && !lblEl.isDeleted) {
            row.label = lblEl.text ?? "";
            row.labelColor = lblEl.strokeColor;
            row.labelFontSize = lblEl.fontSize;
          }
        }
        return row;
      });

    const text = summary.length
      ? JSON.stringify(summary, null, 2)
      : `Scene '${id}' is empty.`;
    return { content: [{ type: "text", text }] };
  },
);

server.tool(
  "list_scenes",
  "List the .excalidraw scenes that exist, so you can pick a `filename` to pass " +
    "to the other tools.",
  {},
  async () => {
    // With a relay, the files live where the relay runs (possibly another host /
    // container) — ask it for the list of scene names.
    if (RELAY_URL) {
      let list: Array<{ id: string; name: string }> = [];
      try {
        const res = await fetch(`${RELAY_URL}/scenes`);
        if (res.ok) list = (await res.json()) as Array<{ id: string; name: string }>;
      } catch {
        // relay unreachable
      }
      const text = list.length ? list.map((s) => s.name).join("\n") : "No scenes found.";
      return { content: [{ type: "text", text }] };
    }

    let files: string[] = [];
    try {
      files = (await fs.readdir(OUTPUT_DIR)).filter((f) => f.endsWith(".excalidraw"));
    } catch {
      // directory not created yet
    }
    const text = files.length
      ? files.map((f) => resolveScenePath(f)).join("\n")
      : `No scenes found in ${OUTPUT_DIR}`;
    return { content: [{ type: "text", text }] };
  },
);

server.tool(
  "read_scene",
  "Read back a scene's raw Excalidraw JSON. Prefer describe_scene for a compact, " +
    "id-focused view; use this when you need the full element fidelity.",
  {
    filename: z
      .string()
      .optional()
      .describe("Scene name to read. Omit to use the scene open in the browser."),
  },
  async ({ filename }) => {
    const id = await resolveScene(filename);
    const scene = await getScene(id);
    return { content: [{ type: "text", text: JSON.stringify(scene, null, 2) }] };
  },
);

server.tool(
  "current_scene",
  "Report which scene the user currently has open in the browser — set by the " +
    "scene picker or by following Claude's drawing. Use this to know what 'the " +
    "current scene' refers to. The editing tools default to it when `filename` " +
    "is omitted.",
  {},
  async () => {
    const id = await currentSceneId();
    return {
      content: [
        {
          type: "text",
          text: id
            ? `Current scene: ${id.replace(/\.excalidraw$/, "")} (${id})`
            : RELAY_URL
              ? "No scene is currently loaded in the browser."
              : "No relay is configured, so there is no 'current scene'. Pass filenames explicitly.",
        },
      ],
    };
  },
);

server.tool(
  "export_scene",
  "Export a scene to a PNG or SVG image using the live browser's renderer — the " +
    "same path as Excalidraw's 'Export image' menu — routed through the relay. " +
    "Requires a relay AND the scene to be open in a connected browser tab. Writes " +
    "the image next to the .excalidraw file and returns it.",
  {
    filename: z
      .string()
      .optional()
      .describe("Scene to export. Omit to use the scene open in the browser."),
    format: z.enum(["png", "svg"]).optional().describe("Image format. Default 'png'."),
    scale: z
      .number()
      .optional()
      .describe("PNG resolution multiplier (1–3). Default 1; ignored for SVG."),
    background: z
      .boolean()
      .optional()
      .describe(
        "Include the canvas background. Default true; set false for a transparent " +
          "PNG / no background rectangle in the SVG.",
      ),
  },
  async ({ filename, format, scale, background }) => {
    if (!RELAY_URL) {
      throw new Error(
        "export_scene needs a relay (the browser does the rendering); none is configured.",
      );
    }
    const id = await resolveScene(filename);
    const res = await fetch(`${RELAY_URL}/scene/${encodeURIComponent(id)}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format: format ?? "png", scale, background }),
    });
    if (!res.ok) {
      throw new Error(`Export failed (${res.status}): ${await res.text()}`);
    }
    const result = (await res.json()) as {
      format: "png" | "svg";
      encoding: "base64" | "utf8";
      data: string;
      path: string;
    };
    if (result.format === "png") {
      return {
        content: [
          { type: "image", data: result.data, mimeType: "image/png" },
          { type: "text", text: `Exported '${id}' to PNG → ${result.path}` },
        ],
      };
    }
    return {
      content: [
        { type: "text", text: `Exported '${id}' to SVG → ${result.path}\n\n${result.data}` },
      ],
    };
  },
);

server.tool(
  "reload_scene",
  "Re-sync a scene from its .excalidraw file on disk into the relay and every " +
    "open browser tab. For when the file changed from OUTSIDE this MCP server — " +
    "a human hand-editing the JSON, or another tool exporting into it. Not for " +
    "your own edits: those already go live immediately via the other tools.",
  {
    filename: z
      .string()
      .optional()
      .describe("Scene to reload. Omit to use the scene open in the browser."),
  },
  async ({ filename }) => {
    if (!RELAY_URL) {
      throw new Error(
        "reload_scene needs a relay; in file-mode every read already hits disk directly.",
      );
    }
    const id = await resolveScene(filename);
    const res = await fetch(`${RELAY_URL}/scene/${encodeURIComponent(id)}/reload`, {
      method: "POST",
    });
    if (res.status === 404) {
      throw new Error(`No scene file found for '${id}'.`);
    }
    if (!res.ok) {
      throw new Error(`Reload failed (${res.status}): ${await res.text()}`);
    }
    const result = (await res.json()) as { elements: number };
    return {
      content: [
        {
          type: "text",
          text: `Reloaded '${id}' from disk (${result.elements} element(s)). ${await whereText(id)}`,
        },
      ],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs; stdout is the MCP transport.
  console.error(
    RELAY_URL
      ? `excalidraw-mcp ready. Relay: ${RELAY_URL} (output dir: ${OUTPUT_DIR})`
      : `excalidraw-mcp ready. Output dir: ${OUTPUT_DIR}`,
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});