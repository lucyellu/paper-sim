# Paper Sim

A web-first sandbox for **paper folding and packaging dielines**. Design a flat sheet (the
dieline — cut and crease lines), fold it step by step in 3D with direct-manipulation gizmos, wrap
it in artwork, and export both printable instructions and real 3D meshes.

Think PackCAD's folding-simulation UX, generalized from packaging to origami, with a cozy
craft-table aesthetic. It runs entirely in the browser — no server, no account.

## How it works

The engine is a **kinematic hinge tree**, not a physics solver. A dieline is a flat planar graph of
vertices, edges (typed *cut* or *crease*), and faces (rigid panels). Folding is one angle per crease;
the 3D shape is derived each frame by forward kinematics. That makes folding predictable, stable, and
gizmo-friendly — and it means **curves are just many small folds** (a can is a fan of 24 creases).

Everything is event-sourced: every authoring action is an op in an append-only log persisted inside
the save file, so **undo survives save → load** (Maya-style construction history).

## Features

- **Templates** — tuck box, gable milk carton (square or rectangular), and a faceted-cylinder can
  label. Each ships with its fold steps recorded — open it and press play.
- **Fold gizmo** — click a panel, drag the orange ring to fold its hinge (soft-snaps to target
  angles). Ctrl-click multiple panels to fold them together with a 0–100% slider.
- **Maya-style transform tools** — `Q`/`W`/`E`/`R` = select / move / rotate / scale, with an
  in-scene gizmo and numeric fields. `1`/`2`/`3` switch Object / Face / **Edge** select modes.
- **Edge-ring reshape** — in Edge mode, double-click to select a whole ring (e.g. a carton top),
  then drag its orange handle (or use numeric nudges) to resize the model. Works on the folded
  model too — it's a dieline edit, so the fold steps re-apply at the new size.
- **Dieline editor** — draw/delete/retype cut & crease lines, set target angles, move points.
  Includes a **Trace** backdrop (drop in a reference dieline image and draw over it) and a
  **Texture / UV editor** to fit a printed design onto the panels.
- **Materials** — plain color, procedural kraft paper, or an uploaded texture, plus a design
  overlay mapped onto the dieline like a product mockup.
- **Exports**
  - Dieline **SVG / PDF** (line art) and **PNG / SVG / PDF with artwork** (the printed design
    composited under the cut/crease lines).
  - **Instructions** — a printable page (and PDF) with the dieline + one numbered 3D snapshot per
    fold step.
  - **3D mesh** — **OBJ**, **GLB**, and **FBX**, in folded and flat poses, textured, for
    Maya / Blender / Roblox.
  - **Project bundle** — a zip of the `.fold` file (model + history), dieline, snapshot, and
    instructions.
- **Workspace** — quad viewport (perspective + ortho), resizable/collapsible panels, dark mode,
  per-project numbered export names.

## Quickstart

```sh
cd app
npm install
npm run dev        # http://localhost:5173
```

On Windows you can also double-click `launch-paper-sim.cmd` (or the "Paper Sim" desktop shortcut) —
it starts the dev server if needed and opens the browser.

See [`app/README.md`](app/README.md) for the full controls reference.

## Folding an image into a model

The engine separates **geometry** (where the fold lines are) from **artwork** (the printed design,
which rides on top as a texture). To fold a printed dieline like a milk carton:

1. `File → New…` → Milk carton (1 L tall) for a typical rectangular carton (or Can label for a tube).
2. Open the dieline editor (**✎**) → **Texture** tool → *Add design* and drop in your artwork.
3. Use the Texture inspector (offset / scale / rotate) to register the art onto the panels.
4. Press **play** to fold, then **Export** a mesh or instructions.

For a dieline that isn't one of the templates, use the **Trace** tool to draw the cut/crease lines
over your reference image. Automatic line detection from a raster is **not** provided — cut vs.
crease isn't recoverable from pixels without color-coded strokes.

## Project layout

```
app/                    Vite + TypeScript + React + three.js + zustand app
  src/model/            document model, templates (carton/gable/can), fold FK, editing, exporters
  src/viewer/           three.js scene, gizmos, texture baking
  src/ui/               panels, top menu, dieline editor, exports
  scripts/verify-*.mjs  Playwright smoke tests driving the real dev server
STATE.md                living design doc: decisions, architecture, roadmap, progress log
```

## Verify

With the dev server running (`PAPERSIM_URL` overrides `http://localhost:5173/`):

```sh
cd app
node scripts/verify.mjs && node scripts/verify-gizmo.mjs && node scripts/verify-v2.mjs \
  && node scripts/verify-v3.mjs && node scripts/verify-v4.mjs && node scripts/verify-v5.mjs \
  && node scripts/verify-v6.mjs
```

Each is a headless Playwright check of the real app (folding, undo/redo, save-load round-trips,
gable closure math, mesh export bytes, the can/rectangular-gable geometry, textured exports, and the
edge-ring handle). Screenshots land in `app/scripts/shots/`.

## Status

v0 + v0.5 + v1 slices complete. Not a physics toy, not freeform cloth folding, not multiplayer.
See [`STATE.md`](STATE.md) for the full roadmap and design decisions.

## Tech

three.js · TypeScript · React · Vite · zustand. Save files are standard
[FOLD](https://github.com/edemaine/fold) JSON with `paperSim:*` extension fields; `Load` also imports
plain FOLD files from other tools.
