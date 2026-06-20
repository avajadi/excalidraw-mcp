#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import {
  buildScene,
  buildAddDelta,
  buildUpdateDelta,
  buildDeleteDelta,
  elementSchema,
  updatePatchSchema,
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
function whereText(id: string): string {
  return RELAY_URL
    ? `An open tab follows automatically; otherwise open: ${liveUrl(id)}`
    : `Wrote ${resolveScenePath(id)} — open it in Excalidraw to view/edit.`;
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
          text: `Created scene '${id}' with ${scene.elements.length} element(s). ${whereText(id)}`,
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
          text: `Added ${created.length} element(s) to '${id}':\n${list}\n${whereText(id)}`,
        },
      ],
    };
  },
);

server.tool(
  "update_element",
  "Change one existing element by id: its colors/style, its label or text, " +
    "and/or its position and size. Moving or resizing a shape recenters its " +
    "label and reroutes any arrows bound to it. Use describe_scene to find ids.",
  {
    filename: z
      .string()
      .optional()
      .describe("Scene containing the element. Omit to use the scene open in the browser."),
    id: z.string().describe("Element id to change (from describe_scene)."),
    patch: updatePatchSchema.describe("Fields to change; omit what stays the same."),
  },
  async ({ filename, id, patch }) => {
    const sid = await resolveScene(filename);
    const scene = await getScene(sid);
    const ops = buildUpdateDelta(scene, id, patch);
    await pushOps(sid, ops);
    return {
      content: [{ type: "text", text: `Updated '${id}' in '${sid}'. ${whereText(sid)}` }],
    };
  },
);

server.tool(
  "delete_element",
  "Delete one element by id. Deleting a shape also removes its label and any " +
    "arrows bound to it (which would otherwise dangle). Use describe_scene for ids.",
  {
    filename: z
      .string()
      .optional()
      .describe("Scene containing the element. Omit to use the scene open in the browser."),
    id: z.string().describe("Element id to delete (from describe_scene)."),
  },
  async ({ filename, id }) => {
    const sid = await resolveScene(filename);
    const scene = await getScene(sid);
    const ops = buildDeleteDelta(scene, id);
    await pushOps(sid, ops);
    const removed = ops.filter((o) => o.type === "delete").length;
    return {
      content: [
        { type: "text", text: `Deleted ${removed} element(s) from '${sid}'. ${whereText(sid)}` },
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
      .filter((e) => !(e.type === "text" && e.containerId)) // labels fold into shapes
      .map((e) => {
        const row: Record<string, unknown> = {
          id: e.id,
          type: e.type,
          x: Math.round(e.x as number),
          y: Math.round(e.y as number),
          w: Math.round(e.width as number),
          h: Math.round(e.height as number),
        };
        if (e.type === "text") {
          row.text = e.text;
        } else if (e.type === "arrow" || e.type === "line") {
          row.from = (e.startBinding as { elementId: string } | null)?.elementId ?? null;
          row.to = (e.endBinding as { elementId: string } | null)?.elementId ?? null;
        } else {
          const lbl = ((e.boundElements ?? []) as Array<{ type: string; id: string }>).find(
            (b) => b.type === "text",
          );
          if (lbl) row.label = byId.get(lbl.id)?.text ?? "";
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
  "List the .excalidraw files already generated in the output directory.",
  {},
  async () => {
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