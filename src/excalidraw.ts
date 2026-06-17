import { randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * Excalidraw scene generation.
 *
 * The public surface is intentionally small: callers describe shapes with a
 * handful of friendly fields (`type`, `x`, `y`, `label`, `startId`, ...) and we
 * expand each one into the verbose element object that Excalidraw expects.
 * Anything we leave off (fractional `index`, exact bindings geometry, ...) is
 * recomputed by Excalidraw's `restore()` pass on import, so the output stays
 * valid even though we only fill in the meaningful fields.
 */

// ---------------------------------------------------------------------------
// Input schema (shared with the MCP tool definition)
// ---------------------------------------------------------------------------

const arrowhead = z
  .enum(["arrow", "triangle", "dot", "bar", "none"])
  .describe("Arrowhead style; 'none' for no head.");

export const elementSchema = z.object({
  type: z
    .enum(["rectangle", "ellipse", "diamond", "text", "arrow", "line"])
    .describe("Shape kind."),
  id: z
    .string()
    .optional()
    .describe("Stable id. Required if an arrow/line wants to bind to it."),
  x: z.number().optional().describe("Left/top x. Defaults to 0."),
  y: z.number().optional().describe("Left/top y. Defaults to 0."),
  width: z.number().optional().describe("Width for box shapes. Default 160."),
  height: z.number().optional().describe("Height for box shapes. Default 80."),
  text: z.string().optional().describe("Text content for `type: text`."),
  label: z
    .string()
    .optional()
    .describe("Centered label bound inside a rectangle/ellipse/diamond."),
  strokeColor: z.string().optional().describe("Stroke color, e.g. '#1e1e1e'."),
  backgroundColor: z
    .string()
    .optional()
    .describe("Fill color, e.g. '#a5d8ff' or 'transparent'."),
  fillStyle: z.enum(["hachure", "cross-hatch", "solid"]).optional(),
  strokeWidth: z.number().optional().describe("1 thin, 2 bold, 4 extra bold."),
  strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
  roughness: z
    .number()
    .optional()
    .describe("0 architect, 1 artist, 2 cartoonist."),
  fontSize: z.number().optional().describe("Text/label font size. Default 20."),
  // Linear-element (arrow/line) fields:
  startId: z
    .string()
    .optional()
    .describe("Bind arrow/line start to this element id."),
  endId: z
    .string()
    .optional()
    .describe("Bind arrow/line end to this element id."),
  x2: z.number().optional().describe("End x for an unbound arrow/line."),
  y2: z.number().optional().describe("End y for an unbound arrow/line."),
  startArrowhead: arrowhead.optional(),
  endArrowhead: arrowhead.optional(),
});

export type ElementSpec = z.infer<typeof elementSchema>;

export interface SceneOptions {
  viewBackgroundColor?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AnyElement = Record<string, unknown> & {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  boundElements: Array<{ type: string; id: string }>;
};

const DEFAULT_W = 160;
const DEFAULT_H = 80;
const LINE_HEIGHT = 1.25;

function randomId(): string {
  return randomBytes(12).toString("base64url").slice(0, 16);
}

function nonce(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/** Rough text metrics — good enough for initial layout; Excalidraw refines on edit. */
function measureText(text: string, fontSize: number): { width: number; height: number } {
  const lines = text.split("\n");
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
  const width = Math.max(longest * fontSize * 0.55, fontSize);
  const height = lines.length * fontSize * LINE_HEIGHT;
  return { width, height };
}

function arrowheadValue(v: string | undefined, fallback: string | null): string | null {
  if (v === undefined) return fallback;
  return v === "none" ? null : v;
}

/** Common element fields shared by every shape. */
function baseElement(
  type: string,
  x: number,
  y: number,
  width: number,
  height: number,
  spec: Partial<ElementSpec>,
): AnyElement {
  return {
    id: spec.id ?? randomId(),
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: spec.strokeColor ?? "#1e1e1e",
    backgroundColor: spec.backgroundColor ?? "transparent",
    fillStyle: spec.fillStyle ?? "solid",
    strokeWidth: spec.strokeWidth ?? 2,
    strokeStyle: spec.strokeStyle ?? "solid",
    roughness: spec.roughness ?? 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: type === "rectangle" ? { type: 3 } : null,
    seed: nonce(),
    version: 1,
    versionNonce: nonce(),
    isDeleted: false,
    boundElements: [],
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

function makeBoundLabel(container: AnyElement, text: string, fontSize: number): AnyElement {
  const { width, height } = measureText(text, fontSize);
  const el = baseElement("text", 0, 0, width, height, {});
  container.boundElements.push({ type: "text", id: el.id });
  return {
    ...el,
    x: container.x + (container.width - width) / 2,
    y: container.y + (container.height - height) / 2,
    text,
    fontSize,
    fontFamily: 1,
    textAlign: "center",
    verticalAlign: "middle",
    baseline: Math.round(fontSize * 0.9),
    containerId: container.id,
    originalText: text,
    lineHeight: LINE_HEIGHT,
    autoResize: true,
  };
}

function makeText(spec: ElementSpec): AnyElement {
  const text = spec.text ?? "";
  const fontSize = spec.fontSize ?? 20;
  const { width, height } = measureText(text, fontSize);
  const el = baseElement("text", spec.x ?? 0, spec.y ?? 0, width, height, spec);
  return {
    ...el,
    text,
    fontSize,
    fontFamily: 1,
    textAlign: "left",
    verticalAlign: "top",
    baseline: Math.round(fontSize * 0.9),
    containerId: null,
    originalText: text,
    lineHeight: LINE_HEIGHT,
    autoResize: true,
  };
}

function center(el: AnyElement): { x: number; y: number } {
  return { x: el.x + el.width / 2, y: el.y + el.height / 2 };
}

function makeLinear(spec: ElementSpec, byId: Map<string, AnyElement>): AnyElement {
  const id = spec.id ?? randomId();
  const startEl = spec.startId ? byId.get(spec.startId) : undefined;
  const endEl = spec.endId ? byId.get(spec.endId) : undefined;

  const start = startEl ? center(startEl) : { x: spec.x ?? 0, y: spec.y ?? 0 };
  const end = endEl
    ? center(endEl)
    : { x: spec.x2 ?? start.x + 100, y: spec.y2 ?? start.y };

  const startBinding = startEl
    ? { elementId: startEl.id, focus: 0, gap: 4 }
    : null;
  const endBinding = endEl ? { elementId: endEl.id, focus: 0, gap: 4 } : null;
  if (startEl) startEl.boundElements.push({ type: spec.type, id });
  if (endEl) endEl.boundElements.push({ type: spec.type, id });

  const el = baseElement(
    spec.type,
    start.x,
    start.y,
    Math.abs(end.x - start.x),
    Math.abs(end.y - start.y),
    { ...spec, id },
  );

  return {
    ...el,
    points: [
      [0, 0],
      [end.x - start.x, end.y - start.y],
    ],
    lastCommittedPoint: null,
    startBinding,
    endBinding,
    startArrowhead: arrowheadValue(spec.startArrowhead, null),
    endArrowhead: arrowheadValue(spec.endArrowhead, spec.type === "arrow" ? "arrow" : null),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildScene(specs: ElementSpec[], opts: SceneOptions = {}) {
  const byId = new Map<string, AnyElement>();
  const shapes: AnyElement[] = [];
  const labels: AnyElement[] = [];
  const linears: AnyElement[] = [];

  // Pass 1: box shapes + standalone text, so arrows can bind to any of them.
  for (const spec of specs) {
    if (spec.type === "arrow" || spec.type === "line") continue;

    if (spec.type === "text") {
      const t = makeText(spec);
      shapes.push(t);
      byId.set(t.id, t);
      continue;
    }

    const el = baseElement(
      spec.type,
      spec.x ?? 0,
      spec.y ?? 0,
      spec.width ?? DEFAULT_W,
      spec.height ?? DEFAULT_H,
      spec,
    );
    shapes.push(el);
    byId.set(el.id, el);

    if (spec.label) {
      labels.push(makeBoundLabel(el, spec.label, spec.fontSize ?? 20));
    }
  }

  // Pass 2: arrows / lines (may reference shapes defined anywhere above).
  for (const spec of specs) {
    if (spec.type === "arrow" || spec.type === "line") {
      linears.push(makeLinear(spec, byId));
    }
  }

  return {
    type: "excalidraw",
    version: 2,
    source: "excalidraw-mcp",
    elements: [...shapes, ...labels, ...linears],
    appState: {
      gridSize: null,
      viewBackgroundColor: opts.viewBackgroundColor ?? "#ffffff",
    },
    files: {},
  };
}
