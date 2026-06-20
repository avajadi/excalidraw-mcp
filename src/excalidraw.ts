import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Op, Scene, Element } from "./scene.js";

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

// A fresh instance per call: sharing one instance makes the schema generator
// emit a `$ref` for the second use, which the Anthropic tool-schema API rejects.
const arrowhead = () =>
  z
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
  startArrowhead: arrowhead().optional(),
  endArrowhead: arrowhead().optional(),
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
const LABEL_PAD_X = 12;
const LABEL_PAD_Y = 8;

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
  const m = measureText(text, fontSize);
  // Keep the text within the container's interior so it never overflows.
  const width = Math.min(m.width, container.width - LABEL_PAD_X * 2);
  const height = m.height;
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

const BINDING_GAP = 4;

/**
 * Point where a ray from `box`'s center toward `towards` crosses the box border,
 * pushed `gap` px further out. This is what makes a bound arrow start/end at the
 * edge of a shape instead of its center. Uses the bounding box for all shapes —
 * exact for rectangles, a close approximation for ellipse/diamond.
 */
function borderPoint(
  box: AnyElement,
  towards: { x: number; y: number },
  gap: number,
): { x: number; y: number } {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = towards.x - cx;
  const dy = towards.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };

  const hw = box.width / 2;
  const hh = box.height / 2;
  // Scale the direction so the longer-axis component just reaches the border.
  const t = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
  const len = Math.hypot(dx, dy);
  return {
    x: cx + dx * t + (dx / len) * gap,
    y: cy + dy * t + (dy / len) * gap,
  };
}

function makeLinear(spec: ElementSpec, byId: Map<string, AnyElement>): AnyElement {
  const id = spec.id ?? randomId();
  const startEl = spec.startId ? byId.get(spec.startId) : undefined;
  const endEl = spec.endId ? byId.get(spec.endId) : undefined;

  // Anchor each unbound end at its explicit coordinate; aim bound ends at the
  // *other* end's center, then clip to the border so arrows touch edges.
  const startCenter = startEl ? center(startEl) : { x: spec.x ?? 0, y: spec.y ?? 0 };
  const endCenter = endEl
    ? center(endEl)
    : { x: spec.x2 ?? startCenter.x + 100, y: spec.y2 ?? startCenter.y };

  const start = startEl ? borderPoint(startEl, endCenter, BINDING_GAP) : startCenter;
  const end = endEl ? borderPoint(endEl, startCenter, BINDING_GAP) : endCenter;

  const startBinding = startEl
    ? { elementId: startEl.id, focus: 0, gap: BINDING_GAP }
    : null;
  const endBinding = endEl ? { elementId: endEl.id, focus: 0, gap: BINDING_GAP } : null;
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

/** Mark an element as freshly changed so the browser's signature guard re-renders it. */
function bumpVersion(el: AnyElement): AnyElement {
  el.version = (typeof el.version === "number" ? el.version : 1) + 1;
  el.versionNonce = nonce();
  el.updated = Date.now();
  return el;
}

/**
 * Recompute a bound arrow/line's endpoints from the *current* geometry of the
 * shapes it is bound to, clipping each bound end to that shape's border. Free
 * ends keep their absolute position. Returns false if the element binds nothing.
 */
function rerouteArrow(arrow: AnyElement, byId: Map<string, AnyElement>): boolean {
  const sb = arrow.startBinding as { elementId: string } | null;
  const eb = arrow.endBinding as { elementId: string } | null;
  const startEl = sb ? byId.get(sb.elementId) : undefined;
  const endEl = eb ? byId.get(eb.elementId) : undefined;
  if (!startEl && !endEl) return false;

  const pts = arrow.points as [number, number][];
  const tail = pts[pts.length - 1];
  const absStart = { x: arrow.x, y: arrow.y };
  const absEnd = { x: arrow.x + tail[0], y: arrow.y + tail[1] };

  const startCenter = startEl ? center(startEl) : absStart;
  const endCenter = endEl ? center(endEl) : absEnd;
  const start = startEl ? borderPoint(startEl, endCenter, BINDING_GAP) : absStart;
  const end = endEl ? borderPoint(endEl, startCenter, BINDING_GAP) : absEnd;

  arrow.x = start.x;
  arrow.y = start.y;
  arrow.width = Math.abs(end.x - start.x);
  arrow.height = Math.abs(end.y - start.y);
  arrow.points = [
    [0, 0],
    [end.x - start.x, end.y - start.y],
  ];
  bumpVersion(arrow);
  return true;
}

/**
 * Expand specs into elements, seeding `byId` with whatever already exists so new
 * arrows can bind to shapes from earlier turns or drawn by hand in the browser.
 * Returns the newly created elements plus any pre-existing element whose
 * `boundElements` we mutated (an arrow bound onto it).
 */
function buildPasses(
  specs: ElementSpec[],
  byId: Map<string, AnyElement>,
): { created: AnyElement[]; touched: AnyElement[]; refs: CreatedRef[] } {
  const existingIds = new Set(byId.keys());
  const shapes: AnyElement[] = [];
  const labels: AnyElement[] = [];
  const linears: AnyElement[] = [];
  const touchedIds = new Set<string>();
  const refs: CreatedRef[] = [];

  // Pass 1: box shapes + standalone text, so arrows can bind to any of them.
  for (const spec of specs) {
    if (spec.type === "arrow" || spec.type === "line") continue;

    if (spec.type === "text") {
      const t = makeText(spec);
      shapes.push(t);
      byId.set(t.id, t);
      refs.push({ id: t.id, type: "text", text: spec.text });
      continue;
    }

    let width = spec.width ?? DEFAULT_W;
    let height = spec.height ?? DEFAULT_H;

    // Grow the box so its bound label fits. Ellipses/diamonds only expose an
    // inscribed area for text, so they need extra room beyond the text metrics.
    if (spec.label) {
      const m = measureText(spec.label, spec.fontSize ?? 20);
      const factor = spec.type === "rectangle" ? 1 : 1.5;
      width = Math.max(width, Math.ceil(m.width * factor + LABEL_PAD_X * 2));
      height = Math.max(height, Math.ceil(m.height * factor + LABEL_PAD_Y * 2));
    }

    const el = baseElement(spec.type, spec.x ?? 0, spec.y ?? 0, width, height, spec);
    shapes.push(el);
    byId.set(el.id, el);
    refs.push({ id: el.id, type: spec.type, label: spec.label });

    if (spec.label) {
      labels.push(makeBoundLabel(el, spec.label, spec.fontSize ?? 20));
    }
  }

  // Pass 2: arrows / lines (may reference shapes defined anywhere above, or that
  // already existed before this batch).
  for (const spec of specs) {
    if (spec.type !== "arrow" && spec.type !== "line") continue;
    const el = makeLinear(spec, byId);
    linears.push(el);
    byId.set(el.id, el);
    refs.push({ id: el.id, type: spec.type });
    // An arrow bound onto a pre-existing shape mutated that shape's
    // boundElements, so it must be re-sent too.
    for (const ref of [spec.startId, spec.endId]) {
      if (ref && existingIds.has(ref)) touchedIds.add(ref);
    }
  }

  const touched = [...touchedIds].map((id) => bumpVersion(byId.get(id)!));
  return { created: [...shapes, ...labels, ...linears], touched, refs };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Reference to an element create_scene / add_elements produced, for the reply. */
export interface CreatedRef {
  id: string;
  type: string;
  label?: string;
  text?: string;
}

/** Build a complete scene from scratch (used by create_scene — replaces all). */
export function buildScene(specs: ElementSpec[], opts: SceneOptions = {}) {
  const { created } = buildPasses(specs, new Map<string, AnyElement>());
  return {
    type: "excalidraw",
    version: 2,
    source: "excalidraw-mcp",
    elements: created,
    appState: {
      gridSize: null,
      viewBackgroundColor: opts.viewBackgroundColor ?? "#ffffff",
    },
    files: {},
  };
}

/**
 * Build the ops needed to *add* specs to an existing scene without disturbing
 * anything else. New arrows may bind to elements already in the scene.
 */
export function buildAddDelta(
  specs: ElementSpec[],
  scene: Scene,
): { ops: Op[]; created: CreatedRef[] } {
  const byId = new Map<string, AnyElement>();
  for (const el of scene.elements ?? []) byId.set(el.id, el as AnyElement);
  const { created, touched, refs } = buildPasses(specs, byId);
  const ops: Op[] = [...created, ...touched].map((element) => ({
    type: "upsert",
    element: element as Element,
  }));
  return { ops, created: refs };
}

/** Fields an update_element call may change. Geometry changes reroute bindings. */
export const updatePatchSchema = z.object({
  label: z.string().optional().describe("Replace the bound label / text content."),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  strokeColor: z.string().optional(),
  backgroundColor: z.string().optional(),
  fillStyle: z.enum(["hachure", "cross-hatch", "solid"]).optional(),
  strokeWidth: z.number().optional(),
  strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
  roughness: z.number().optional(),
  fontSize: z.number().optional(),
});
export type UpdatePatch = z.infer<typeof updatePatchSchema>;

/** Find the bound text label of a container element, if any. */
function boundLabel(el: AnyElement, byId: Map<string, AnyElement>): AnyElement | undefined {
  for (const b of (el.boundElements ?? []) as Array<{ type: string; id: string }>) {
    if (b.type === "text") return byId.get(b.id);
  }
  return undefined;
}

/** Build the ops to update one element's appearance, text, and/or geometry. */
export function buildUpdateDelta(scene: Scene, id: string, patch: UpdatePatch): Op[] {
  const byId = new Map<string, AnyElement>();
  for (const el of scene.elements ?? []) byId.set(el.id, el as AnyElement);
  const el = byId.get(id);
  if (!el) throw new Error(`No element '${id}' in scene`);

  const touched = new Set<AnyElement>([el]);
  const visual: (keyof UpdatePatch)[] = [
    "strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle", "roughness", "fontSize",
  ];
  for (const key of visual) {
    if (patch[key] !== undefined) (el as Record<string, unknown>)[key] = patch[key];
  }

  // Text: a standalone text element edits itself; a container edits its label.
  if (patch.label !== undefined) {
    if (el.type === "text") {
      el.text = patch.label;
      el.originalText = patch.label;
    } else {
      const lbl = boundLabel(el, byId);
      if (lbl) {
        lbl.text = patch.label;
        lbl.originalText = patch.label;
        touched.add(lbl);
      }
    }
  }

  // Geometry: move/resize, then recenter the label and reroute bound arrows.
  const moved =
    patch.x !== undefined || patch.y !== undefined ||
    patch.width !== undefined || patch.height !== undefined;
  if (moved) {
    if (patch.x !== undefined) el.x = patch.x;
    if (patch.y !== undefined) el.y = patch.y;
    if (patch.width !== undefined) el.width = patch.width;
    if (patch.height !== undefined) el.height = patch.height;

    const lbl = boundLabel(el, byId);
    if (lbl) {
      lbl.x = el.x + (el.width - lbl.width) / 2;
      lbl.y = el.y + (el.height - lbl.height) / 2;
      touched.add(lbl);
    }
    for (const b of (el.boundElements ?? []) as Array<{ type: string; id: string }>) {
      if (b.type === "arrow" || b.type === "line") {
        const arrow = byId.get(b.id);
        if (arrow && rerouteArrow(arrow, byId)) touched.add(arrow);
      }
    }
  }

  for (const t of touched) bumpVersion(t);
  return [...touched].map((element) => ({ type: "upsert", element: element as Element }));
}

/**
 * Build the ops to delete an element. Cascades to its bound label, deletes
 * arrows that bind to it (they would dangle), and strips the deleted arrow ids
 * from the shape on the other end.
 */
export function buildDeleteDelta(scene: Scene, id: string): Op[] {
  const byId = new Map<string, AnyElement>();
  for (const el of scene.elements ?? []) byId.set(el.id, el as AnyElement);
  const el = byId.get(id);
  if (!el) throw new Error(`No element '${id}' in scene`);

  const remove = new Set<string>([id]);
  const upsert = new Set<AnyElement>();

  for (const b of (el.boundElements ?? []) as Array<{ type: string; id: string }>) {
    const child = byId.get(b.id);
    if (!child) continue;
    if (b.type === "text") {
      remove.add(b.id); // a bound label belongs to its container
    } else {
      // A bound arrow can't survive losing an endpoint — delete it and unbind
      // the shape on its other end.
      remove.add(b.id);
      const other =
        (child.startBinding as { elementId: string } | null)?.elementId === id
          ? (child.endBinding as { elementId: string } | null)?.elementId
          : (child.startBinding as { elementId: string } | null)?.elementId;
      const otherEl = other ? byId.get(other) : undefined;
      if (otherEl && other !== id) {
        otherEl.boundElements = (
          (otherEl.boundElements ?? []) as Array<{ type: string; id: string }>
        ).filter((x) => x.id !== b.id);
        upsert.add(bumpVersion(otherEl));
      }
    }
  }

  const ops: Op[] = [...remove].map((rid) => ({ type: "delete", id: rid }));
  for (const element of upsert) {
    if (!remove.has(element.id)) ops.push({ type: "upsert", element: element as Element });
  }
  return ops;
}
