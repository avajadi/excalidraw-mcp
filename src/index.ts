#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { buildScene, elementSchema, type ElementSpec } from "./excalidraw.js";

const OUTPUT_DIR = process.env.EXCALIDRAW_OUTPUT_DIR
  ? path.resolve(process.env.EXCALIDRAW_OUTPUT_DIR)
  : path.join(process.cwd(), "scenes");

/** Resolve a user-supplied filename safely inside OUTPUT_DIR. */
function resolveScenePath(filename: string): string {
  let name = path.basename(filename.trim());
  if (!name) throw new Error("filename is empty");
  if (!name.endsWith(".excalidraw")) name += ".excalidraw";
  return path.join(OUTPUT_DIR, name);
}

const server = new McpServer({ name: "excalidraw", version: "1.0.0" });

server.tool(
  "create_scene",
  "Generate an Excalidraw drawing from a list of shapes and write it as a " +
    ".excalidraw file. Shapes: rectangle, ellipse, diamond, text, arrow, line. " +
    "Give box shapes an `id` and a `label`; connect them with arrows via " +
    "`startId`/`endId`. Open the resulting file in Excalidraw to view/edit it.",
  {
    filename: z
      .string()
      .describe("Output file name, e.g. 'flowchart' (the .excalidraw suffix is added)."),
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
    const target = resolveScenePath(filename);
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await fs.writeFile(target, JSON.stringify(scene, null, 2), "utf8");
    return {
      content: [
        {
          type: "text",
          text: `Wrote ${scene.elements.length} element(s) to ${target}\nOpen it in Excalidraw via the hamburger menu → Open, or drag the file onto the canvas.`,
        },
      ],
    };
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
      ? files.map((f) => path.join(OUTPUT_DIR, f)).join("\n")
      : `No scenes found in ${OUTPUT_DIR}`;
    return { content: [{ type: "text", text }] };
  },
);

server.tool(
  "read_scene",
  "Read back a previously generated .excalidraw file's raw JSON.",
  {
    filename: z.string().describe("Scene file name to read."),
  },
  async ({ filename }) => {
    const target = resolveScenePath(filename);
    const data = await fs.readFile(target, "utf8");
    return { content: [{ type: "text", text: data }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs; stdout is the MCP transport.
  console.error(`excalidraw-mcp ready. Output dir: ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
