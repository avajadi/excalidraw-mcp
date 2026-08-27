# Excalidraw MCP — User Manual

This MCP lets Claude draw on, and read from, a **live Excalidraw canvas**. You talk to
Claude in plain English; Claude calls the drawing tools and the diagram appears in your
browser in real time.

## Setup

Get the relay running and the MCP registered as described in the
[README](README.md) (live mode), then open the canvas in your browser.

Keep that browser tab open: it's the source of truth for "the current scene," and it's
**required** for image export.

---

## Drawing scenes

Describe the diagram in plain English and it appears on the canvas.

**Create a fresh scene**
> "Draw a login flow: a *Start* box, an arrow to a *Validate credentials* diamond, then
> arrows to *Success* and *Failure* boxes."

Claude calls `create_scene` and the diagram renders live. `create_scene` **replaces** any
scene with that name.

**Add to what's already there (without disturbing it)**
> "On the current scene, add a *Rate limit* box above Validate, and connect it with a
> dashed arrow."

Claude calls `add_elements` — your existing shapes (including anything you drew by hand)
stay put, and new arrows can bind to existing shapes.

**Tweak one element**
> "Make the *Failure* box red and move it 200px to the right."

`update_element` — restyles/moves a single shape; its label re-centers and bound arrows
reroute automatically.

**Delete**
> "Remove the *Rate limit* box."

`delete_element` — also removes its label and any arrows bound to it.

**Style options you can ask for:** stroke/background color, fill style, stroke width/style,
roughness, font size, arrowheads (`arrow` / `triangle` / `dot` / `bar` / `none`), and arrow
bindings between shapes.

---

## Describing scenes loaded in the live canvas

Because the relay tracks what's open in your browser, you can ask Claude about a drawing you
(or it) made — including **edits you made by hand in the browser**.

**What's open right now**
> "What scene am I looking at?"

`current_scene` — reports the scene the browser currently has open.

**Summarize the open scene**
> "Describe what's on the canvas right now."

`describe_scene` — returns a compact, **id-focused** list of elements (reflecting live
browser edits), so Claude can then target specific shapes.

**Work on it without naming it**
> "Add a title at the top of this one."

Every scene tool's `filename` is **optional** — omit it and Claude acts on whatever the
browser has open.

**List your scenes**
> "List all my scenes." → `list_scenes`

**Round-trip example (read → modify)**
> "Look at what's currently on the canvas, then make every diamond yellow."

Claude calls `describe_scene` to get element ids, then `update_element` on each diamond.

---

## Exporting images

> "Export the current scene as a transparent PNG." → `export_scene` with `background: false`
> "Export *login-flow* as an SVG at 2× scale."

`export_scene` renders **PNG or SVG** using the browser's own exporter and saves the image
to your scenes folder (wherever the relay was pointed — e.g. `~/Pictures/excalidraw/scenes`),
alongside the scene. **Requires an open browser tab viewing that scene** — image rendering
needs the canvas and fonts, which only exist in the browser.

---

## Tips & gotchas

- **`create_scene` overwrites** a same-named scene; use **`add_elements`** to extend one.
- **Co-editing works:** edits flow both ways — Claude's changes appear in the browser, and
  your hand-drawn edits show up when Claude calls `describe_scene`.
- **Export needs a live tab** open on that scene, or it fails with a message telling you to
  open it.
- **No relay?** In file-mode fallback Claude saves scene files you open yourself — no live
  canvas, no export.