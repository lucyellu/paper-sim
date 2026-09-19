# Paper Sim — Project State

> Living document. Records the plan, decisions, and progress. Update whenever a decision is made,
> a milestone lands, or scope changes. Newest progress-log entries go on top.

**Status:** v0 + v0.5 + v1 slices complete and verified — app in `app/`, run with `cd app && npm run dev`
**Repo:** https://github.com/lucyellu/paper-sim (branch `main`)
**Last updated:** 2026-09-18

## Picking up in a new session

1. Read this file top to bottom (decisions → architecture → roadmap → progress log).
2. `cd app && npm install && npm run dev` → http://localhost:5173 (`app/README.md` has controls).
3. Verify the world still works: with the dev server running,
   `node scripts/verify.mjs && node scripts/verify-gizmo.mjs && node scripts/verify-v2.mjs && node scripts/verify-v3.mjs && node scripts/verify-v4.mjs && node scripts/verify-v5.mjs && node scripts/verify-v6.mjs && node scripts/verify-v7.mjs && node scripts/verify-v8.mjs && node scripts/verify-v9.mjs && node scripts/verify-v10.mjs && node scripts/verify-v11.mjs && node scripts/verify-v12.mjs && node scripts/verify-v13.mjs`
   Product direction lives in `VISION.md` (pillars, product ladder, what's parked).
   (all logic checks should pass with no page errors; screenshots land in `app/scripts/shots/`;
   `PAPERSIM_URL=http://localhost:PORT/` overrides the target if 5173 is taken).
4. Next: remaining **v1** items (below) — SVG dieline import, per-hinge limits, materials,
   animation export, model library, per-object history, micro-crease fans, cozy UI pass.
5. Local-only, gitignored (not on GitHub): `reference/` (234 MB Pinterest inspiration + GUI art
   direction), `PackCAD_screenshot*.png` (UX reference), `paperstar.jpg`, `assets/`,
   `app/scripts/shots/`. They exist only on this machine — don't rely on them being in the repo.
6. Dev-only test hooks: `window.paperSim` (store, toFoldFile/fromFoldFile) and
   `window.paperSimViewer` (gizmo, views) — used by the verify scripts.

---

## Vision

A web-first sandbox/creation tool for paper folding and origami — an "art canvas" where users
design a flat sheet (dieline/crease pattern), fold it step by step in 3D with direct-manipulation
controls, and export shareable step-by-step instructions. Think PackCAD's folding-simulation UX
generalized from packaging to origami, with a cozy craft-table aesthetic instead of CAD-sterile.

Not a physics toy, not freeform cloth folding, not multiplayer (yet). Social/sandbox-world layer
and image/text→crease-pattern generation are future phases.

---

## Core decisions

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-07-10 | **Do not clone/reverse-engineer PackCAD** | No public repo; legally and practically a dead end. Use it as UX reference only. |
| 2026-07-10 | **Crease-pattern-driven, not freeform folding** | Freeform interactive paper is research-grade thin-shell simulation. Pattern-driven is buildable now. |
| 2026-07-10 | **Kinematic hinge-tree engine, not physics solver** | Rigid panels rotating about crease hinges (forward kinematics, like PackCAD). Predictable, stable, gizmo-friendly. Ghassaei-style relaxation solver is an optional later layer, not the foundation. |
| 2026-07-10 | **Fold steps = keyframes, strictly linear** | A step animates a named group of hinges from angle A to B. Steps play in order; step N starts from step N−1's end state. |
| 2026-07-10 | **Inserting a step mid-sequence deletes all later steps** | (With a confirmation prompt.) Keeps the engine simple — no downstream re-solve. Reordering freedom deferred indefinitely. |
| 2026-07-10 | **Undo/redo for all standard authoring actions** | Command-pattern history: crease edits, step add/delete, angle changes, material changes. File save/load/export included in scope from v0/v1. |
| 2026-07-10 | **Event-sourced document: history survives save/load (Maya-style construction history)** | Document = snapshot + append-only op log, persisted in the file (`paperSim:history`). Undo stack rebuilds on load. History panel shows ops filtered per object (Maya channel-box style). "Delete History" bakes current state and drops the log — whole project (v0) or per object (v1) — to keep files lean and un-convoluted. |
| 2026-07-10 | **FOLD format as save file** | Community standard (Origami Simulator, Rabbit Ear compatible). Our extras (panels, steps, materials) go in `paperSim:*` extension fields. |
| 2026-07-10 | **Stack: three.js + TypeScript + React + Vite** | Web-first. Unity port possible later; FOLD files carry over. |
| 2026-07-10 | **Both interaction modes for fold angles** | In-viewport arc/rotation gizmo on the hinge axis (Maya/Blender-style) *and* numeric sidebar input. |
| 2026-07-10 | **Collision/self-intersection constraints deferred** | Start with per-hinge angle limits only. Finesse later once core controls feel right. |
| 2026-07-10 | **Lucky star is a stress test, not a v0 target** | Strip curving/knotting and the final "puff" are non-rigid. Approximations exist (micro-crease fans for bends; inflate morph for puff) — revisit in v1+. v0 targets: box/carton, simple traditional folds. |
| 2026-07-10 | **Art direction: cozy hand-crafted paper look** | Per `reference/GUI/` — warm palette, paper textures, craft-book feel. |
| 2026-07-11 | **No freeform UV/mesh-UV editor — UVs stay locked to dieline flat coords** | The 3D view must be a truthful mockup of the printed object; a UV editor whose only power is making the preview diverge from the print is an anti-feature. Artwork control lives in the dieline-space Texture tool (`overlayTransform`), which changes print + 3D together. Two-sided (inside/outside) material is the legit future gap. |
| 2026-07-12 | **UV editing allowed, but print exports warp to compensate (amends the 2026-07-11 no-UV-editor rule)** | User asked to shift UVs so artwork lines up with panels. Fidelity is preserved by construction: a per-face `FaceUV` (translate/rotate/scale about the face's UV centroid) moves the face's texture coords in 3D, and every artwork print path runs `buildPrintCanvas`, which inverse-warps the artwork back into the face's dieline position (affine, clipped per face) — preview and printout cannot diverge. UV mode lives in the new top-menu **Mode** (Fold / UV / Instructions). Translate is the workhorse; rotate/scale exist but are rare. UV edits are NOT history ops (same as material/transform). |
| 2026-07-11 | **1 dieline unit = 1 cm (physical scale)** | Print-and-fold is the product promise; exports need real dimensions. True-scale PDF export prints at 100% with a 5 cm calibration bar; tiles across A4 pages when bigger. |
| 2026-07-11 | **Edge-ring reshape translates the whole region beyond the ring** | Moving only the ring's own vertices sheared the panels past it (gable top squashed → derived targets invalid → "exploding carton"). `ringRegionVertexIds` moves every vertex at-or-beyond the ring line along the axis, so the cap keeps its exact shape and folds stay valid; only the band behind the ring stretches. |
| 2026-07-11 | **US Letter (8.5×11) is the default paper, not A4** | The audience prints at home in the US; an A4 PDF at 100% clips ~5 cm on Letter. All PDF exports are Letter; A4 becomes a setting later. |
| 2026-07-11 | **Sleeves are the product wedge** | Open-ended printed bands that slip over standard products (12 oz can, 200 ml juice box) — forgiving (no waterproofing/closure), expressive, one sheet + one glue seam. Free designs / paid materials (laminate blanks) is the business sketch. Full vision in `VISION.md`. |
| 2026-07-11 | **Photo-of-product → dieline = classify-to-parametric-template pipeline, NOT a trained generative model** | Image models produce plausible-looking but unfoldable/unregistered dielines. Instead: VLM classifies packaging archetype + estimates dims → parametric builder outputs guaranteed-foldable geometry; artwork recovered by unwarping visible faces (generative fill only for hidden faces). An import wizard in-app, not a separate app. Prereq: more parametric archetypes. |

## Open questions (unresolved)

- Layered folds (one action folding through multiple stacked layers, reverse folds) — v1+ research
  item. v0 supports pre-defined full crease patterns only; steps animate existing creases.
- Image/text → crease pattern generator — separate future tool. Cheap version first: parametric
  generators (box, star, envelope). Origamizer-style is research-heavy.
- Per-object "Delete History" semantics when ops touch multiple objects (e.g. a step animating
  many hinges): bake likely has to compact the shared op for all touched objects at once —
  confirm UX when we build the history panel (v1).
- Instruction-sheet annotation style (auto arc arrows: how much auto-layout do we need for v1?).

---

## Architecture sketch

```
Flat sheet (dieline)  =  cut outline + crease segments
        │  panels = faces between creases; creases = hinges
        ▼
Panel tree            =  root panel + children hanging off hinges
        │  fold state = one angle per hinge
        ▼
Fold steps (keyframes)=  ordered list; each step: {name, [(hinge, fromAngle, toAngle)], duration}
        │  strict linear playback; scrubbing interpolates within a step
        ▼
Renderer (three.js)   =  extrude panels (paper thickness), rotate subtrees via FK
        +  2D pattern inset view (same data, angles = 0)
        +  arc gizmo on selected hinge → drags subtree live
```

**File format:** FOLD (`.fold` JSON) — `vertices_coords`, `edges_vertices`,
`edges_assignment`, `faces_vertices` standard; plus `paperSim:steps`, `paperSim:material`,
`paperSim:panelTree` extension fields.

**History / undo-redo (event-sourced):** every authoring action is an op object
(addCrease, removeCrease, setHingeAngle, addStep, deleteStepsFrom, renameStep, setMaterial, …)
with `do()/undo()`, appended to the document's op log. Each op records the object id(s) it touched.

- **Persistence:** save file = `{ baseSnapshot, opLog, undoCursor }` in `paperSim:history`.
  Loading restores the log and rebuilds the undo/redo stack — undo works across sessions.
- **Per-object view:** history panel filters the log by object id (Maya-style per-object history);
  project-wide view is the unfiltered log.
- **Delete History (bake):** collapses state-so-far into a new baseSnapshot and clears the log —
  project-wide (v0) or per-object compaction (v1). This is the escape hatch for convoluted
  history and file-size growth; autosave may suggest baking past a size threshold.

**Instruction export:** render snapshot per keyframe + auto-drawn arc arrow on moved hinges →
numbered sheet (SVG/PDF) and animated GIF/MP4 of timeline playback.

---

## Roadmap

### v0 — Prove the core (fold a box with a gizmo) — ✅ DONE 2026-07-10
- [x] Vite + TS + React + three.js scaffold (`app/`; zustand for state)
- [x] Document model: sheet, panels, hinges, panel tree; hardcoded tuck-carton dieline (13 panels)
- [x] FK folding: set hinge angle → subtree rotates; paper thickness rendering
- [x] Selection: click panel in 3D or 2D inset; highlight in both
- [x] Arc rotation gizmo on hinge axis (drag to fold, live; Shift snaps 15°)
- [x] Numeric angle input + slider + presets in sidebar (parity with gizmo)
- [x] Fold steps: Add Keyframe snapshots, strict-linear playback + scrub + play button
- [x] Edit-from-middle = confirm + truncate later steps ("⏪ edit from here")
- [x] Undo/redo (op log) incl. Ctrl+Z/Y; log persisted in save file, undo survives load (verified)
- [x] Project-wide "Delete History" (bake snapshot, clear log)
- [x] Save/load `.fold` with `paperSim:*` extensions (incl. `paperSim:history`)

### v0.5 — UX round from first user session — ✅ DONE 2026-07-10
- [x] Timeline notches: one numbered dot per keyframe, click to select/preview
- [x] Selected step actions: ✎ re-edit (deletes it + later, keeps pose to re-record) and
      ⏵ continue-after (deletes later steps) — in timeline and steps panel
- [x] F to frame: zooms all views on the selected panel; resets all views when nothing selected
- [x] Suggested angle presets: dieline carries `targetAngles`; preset buttons tinted by
      closeness to target (strongest = the model's intended fold)
- [x] Gizmo soft-snap to preset/target angles (±5°); Alt = free, Shift = 15° grid
- [x] Quad viewport: perspective + ortho top/front/side, per-view orbit/pan/zoom, layout toggle
- [x] Dark mode (persisted; CSS vars + scene/grid/inset swap)
- [x] Right-hand Details panel: selection info + full history list — click a row to revert/redo
      to that point (detailed undo), ✕ deletes a single action (state recomputed), plus
      "Delete non-deformer" (renames; Maya-style distinction) and "Delete all (bake)"

### v1 — Authoring + export
- [x] Crease-pattern / dieline editor (draw cuts + creases, delete/merge, retype, set target
      angle, move points; edits are undoable `setDoc` history ops) — 2026-07-10
- [ ]   … SVG dieline import (still open; generic FOLD import IS done)
- [x] Generic FOLD import: Load accepts files from other tools (largest face = root,
      `edges_foldAngle` → target angles) — 2026-07-10
- [x] Gable-top milk carton template with spout gusset creases; target angles derived from the
      sealed 3D pose (`model/gable.ts` + `model/targets.ts` dihedral math) — 2026-07-10
- [x] Group folding: Ctrl+click multi-select; 0–100% "fold toward targets" slider; gizmo drives
      the whole group proportionally (`setAngles` op) — 2026-07-10
- [x] Whole-object rotation (Object section, 90° steps) + auto-centering pivot (bbox centered on
      origin, resting on ground; frozen during gizmo drags) — 2026-07-10
- [x] Instruction-sheet export (printable page: dieline + numbered snapshots per step; offscreen
      renders via `viewer/capture.ts`) — fold arrows still TODO — 2026-07-10
- [x] Dieline SVG export (cuts solid, valley/mountain dashed) — 2026-07-10
- [x] PDF export: dieline (vector) + instructions (embedded snapshots) via a dependency-free
      PDF writer (`ui/pdf.ts`) — 2026-07-10
- [x] Materials: base color / procedural kraft / uploaded texture + design-overlay image mapped
      onto the dieline (UVs = flat coords; overlay shows in the pattern editor too); persisted as
      `paperSim:material` — both-sides distinction still TODO — 2026-07-10
- [x] Templates ship with authored fold steps (baked into history base; play through on load)
      (`model/templates.ts`) — 2026-07-10
- [x] Panel UX: resizable + collapsible side panels, collapsible sections (localStorage);
      Object controls moved to the right panel — 2026-07-10
- [x] Maya-style selection: double-click = row, Shift+double-click = column, triple-click =
      whole object (3D view + 2D inset; `rowFaceIds`/`columnFaceIds`) — 2026-07-10
- [x] Maya-style transform tools: Q/W/E/R move/rotate/scale gizmo (`TransformControls`) + numeric
      Transform panel; whole-object `transform` persisted — 2026-07-10
- [x] Select modes (1/2/3 = Object/Face/Edge); edge pick proxies + double-click edge-ring select
      (`edgeRing`) — 2026-07-10
- [x] Axis-constrained edge-ring reshape (drag/nudge a ring to change dimensions, e.g. carton
      height; `moveVertices` + `setDocTransient`, one undoable `setDoc`) — 2026-07-10
- [x] Top menu bar (File / Edit / Export) — 2026-07-10
- [x] 3D mesh export: OBJ + GLB + FBX, folded and flat, textured (`model/meshExport`,
      `objExport`, `fbxExport`, `ui/meshExport` GLB via GLTFExporter) — 2026-07-10
- [x] UV/texture editor: `overlayTransform` (offset/scale/rotate) with a Texture tool + inspector in
      the dieline editor; drives the 3D texture and all PNG exports — 2026-07-10
- [x] Can / label template: faceted cylinder (`model/can.ts`, N vertical creases each folding 360/N;
      one "Roll into a cylinder" step). The "curve capability" via many small rigid folds — 2026-07-11
- [x] Rectangular gable carton: `buildGableCarton({width, depth, height, …})` — the ridge/gusset
      geometry is rigid for any width (only depth couples to the gable height). Menu adds a
      "Milk carton (tall/rect)" preset; the strawberry-milk dieline folds via it — 2026-07-11
- [x] Textured dieline export: PNG / SVG / PDF that composite the material's artwork under the
      cut/crease line work (`dielineTextureCanvas` / `dielineTexturePNG` / `dielineArtworkDataUrl`) —
      2026-07-11
- [x] Trace-backdrop tool: load a saved dieline image behind the dieline editor (drag / scale /
      opacity), draw cuts+creases over it. Session-only (`store.backdrop`, not saved) — 2026-07-11
- [x] True-scale (1:1) printable PDF: 1 unit = 1 cm, print at 100%, 5 cm calibration bar,
      tiles across A4 pages with trim frames when the sheet is bigger (line art + artwork
      variants; `dielinePDFTrueScale`) — 2026-07-11
- [x] Edge-ring reshape fix: rigid translation of the whole region beyond the ring
      (`ringRegionVertexIds`) — shortening a carton no longer explodes the gable — 2026-07-11
- [x] Image → dieline import wizard (File → "Import dieline image…"): measures a raster
      dieline picture (content box, wall fold lines, body band → full GableDims ratios),
      rebuilds the parametric carton at those proportions (user sets body height in cm),
      and auto-registers the artwork via a computed `overlayTransform`
      (`model/dielineImage.ts`, `ui/ImportDielineDialog.tsx`) — 2026-07-11
- [x] Sleeve templates: `buildSleeve` rectangular band (W·D·W·D + seam, 90° creases) with
      juice-box preset, plus a 12 oz can-sleeve preset on the can builder; one-step
      "Wrap the sleeve" fold — 2026-07-11
- [x] US Letter page size for all PDF exports (true-scale, fit-preview, instructions) — 2026-07-11
- [x] Mode menu (Fold / UV / Instructions) + UV editor: per-face UV islands over the artwork,
      drag/rotate/scale with print-warp compensation (`model/uv.ts`, `ui/UVEditor.tsx`,
      `buildPrintCanvas`); Instructions mode = in-app sheet preview (`ui/InstructionsView.tsx`) —
      2026-07-12
- [ ] Per-hinge angle limits (basic constraints)
- [ ] Animation export (GIF/MP4)
- [ ] Starter model library from `reference/` (gift box, cup, boat, peacock…)
- [ ] History panel: per-object filtered op list, per-object Delete History (compaction)
- [ ] Micro-crease fan tool / soft folds (see "Soft folds" note below) — the can shape now ships as a
      faceted cylinder (`model/can.ts`); the fan tool remains for the curved box and the lucky star
- [ ] SVG dieline import (PackCAD-style color mapping — see "Soft folds" note)
- [ ] Cozy UI pass per `reference/GUI/`

### Soft folds / curved creases — findings from PackCAD's curved box (2026-07-10)

`assets/curved_box/` (local-only) holds a PackCAD project we can't load yet. Dissecting it:

- `curvedbox.Dp6qF5YV.json` is the PackCAD project: an **imported SVG dieline** plus operations —
  `OPERATION_IMPORT_SVG` (full SVG string inline), `OPERATION_FOLDING_SETUP` (fixed root face),
  and one `OPERATION_ORIGAMI_SIMULATION` per fold keyframe (groups of edge IDs + target angle —
  same shape as our steps + group folds).
- The SVG encodes semantics by stroke color: **black = cut, red = crease, yellow = soft/curved
  fold lines** — the yellow lines are a *fan of 8 parallel creases* spanning the bend region.
  So PackCAD's "soft fold" is exactly the micro-crease-fan approximation our roadmap planned:
  each fan line takes a fraction of the total bend angle. No new engine needed — our kinematic
  hinge tree already does this; we need (a) SVG import with that color mapping, (b) panels
  bounded by curved (polyline-approximated) outlines, and (c) a "distribute angle across a fan"
  control (a special group fold where each hinge gets total/n).
- Curved panel outlines are just cut paths that aren't straight — our doc model already allows
  arbitrary polygon faces; import needs to flatten Béziers/arcs to polylines.

Suggested attack order for the next round: SVG dieline import (black/red/yellow mapping, Bézier
flattening) → fan group-fold control → rebuild the curved box → then a "can" template.

### v2 — Sandbox & generation
- [ ] Gallery/scene: place multiple folded models in a 3D scene
- [ ] Parametric generators (box, star, envelope) → later image/text-to-crease-pattern tool
- [ ] Sharing/social layer (deferred until core is loved)
- [ ] Optional relaxation solver (Ghassaei-style) for non-rigid-foldable patterns
- [ ] Collision-aware constraints

---

## References

- **PackCAD mockup** (UX reference only): https://app.packcad.com/mockup/ — screenshots in project root
- **amandaghassaei/OrigamiSimulator** (MIT): GPU fold solver, FOLD format — future relaxation layer
- **Rabbit Ear** (MIT): JS crease-pattern authoring/math library — candidate for v1 editor
- **FOLD spec**: https://github.com/edemaine/fold
- **zzhuyii/OrigamiSimulator** (MATLAB): bar-and-hinge physics papers — reference only
- **zippy731/unbender** (Blender): micro-crease bend approximation concept
- `reference/` — target models + instruction-sheet styles; `reference/GUI/` — art direction

---

## Progress log

*(newest first)*

- **2026-09-18 (latest)** — **Fit-the-grid dieline importer + tuck boxes**
  (`BRIEF-dieline-to-fold.md`). File → **Import dieline image…** is now
  `ui/FitDielineDialog.tsx`, which replaces `ImportDielineDialog`. It has two screens.
  **Prep**: rotate ±90°, flip, drag-crop; the result is baked to a new PNG and every
  later step uses it. **Fit**: pick the archetype and layout toggles, drag the
  column/row guide lines (orange/teal) while the archetype's real outline (cut solid,
  crease dashed) is drawn over the picture. ● moves the whole grid, ■ scales it. The
  size is one body-height input with presets **Fit one Letter page** and **Sharpest
  print** (≥150 dpi). A live summary shows box size, sheet size, page fit and print dpi,
  warning below 150; a separate warning appears when the picture's matching panels
  differ by more than 8%. **Build**: newDocument + overlay registered through the same
  guides. **File → Re-fit dieline image…** reopens the session (`store.fitSession`,
  session-only).
  - `model/tuck.ts`: parametric tuck-end box `buildTuckBox({width, depth, height, lid?,
    tuck?, dust?, glue?, style: straight|reverse, order: front-first|side-first,
    glueSide, lidOn: first|second})`. `lidOn` is an extra param beyond the brief: the
    picture's top lid can be on either wide panel. The lid is height = depth; the tuck
    has chamfered corners; dust flaps are tapered and capped at 0.45·W so opposite
    flaps never overlap; the glue flap is tapered. Targets come from the sealed 3D pose
    → `deriveTargetAngles`. New template `'tuckbox'` with 5 fold steps. The legacy
    `'tuck'` template (fixed `buildCarton`) is untouched because many old verify
    scripts depend on its face names. It's relabelled "New — Flap box (classic)". New
    File entries: "Tuck box (reverse / straight tuck)".
  - `model/archetypes.ts`: registry `{tuck, gable}`. Each entry has builder, guides(p),
    fromGuides(g) → {params, mismatch}, layout options, template. Contract: x-guide
    `c0` = flat 0, y-guides `body0` = 0 and `bodyH` = H (the wizard anchors on these).
    Adding a box type = one entry here.
  - `model/dielineFit.ts`: image px ↔ flat cm (uniform scale from the body height,
    anchored at c0/body0), `overlayForFit` (the OverlayTransform), dpi, `fitLetterHeight`
    (binary search on the built sheet), and the initial guess `initialFit`. The guess
    uses the analyzer's new `vCandidates`/`hCandidates`. It picks 5 body lines + glue so
    columns repeat, penalised when the flap band just above/below a column is half
    covered (art edges can fake a repeating grid), plus width left unexplained (e.g. a
    watermark). Lid placement/style is read from which wide panel has a flap. The
    foreground mask threshold is 24 because pastel flaps on cream differ by ~35. Results:
    #126, #118, #107 fully right (columns, rows, all four layout toggles). #83 (rotated)
    and the gable pins need hand-dragging. The gable/tuck auto-pick misses #110, whose
    art isn't column-aligned.
  - Print: `buildPrintCanvas` bleeds art 2 mm past the union of faces (`model/bleed.ts`,
    O(n) nearest-seed propagation) and blanks everything further out to paper. The
    true-scale PDF renders at `PRINT_TEX` 4096 px (other exports stay at 2048). Its
    footer's second line: "folds to ~W × D × H cm · sheet · art ~N dpi · cut solid lines,
    score dashed lines" (`foldedExtents` in fold.ts). The instruction sheet gets the
    size + print line too.
  - Trace-anything: the dieline editor's Trace panel has **Use backdrop as artwork**
    (registers the backdrop rect as the overlay).
  - `verify-v13.mjs`: (1) 16 tuck variants fold to exactly W×H×D with no
    interpenetration or same-kind stacking; the detector self-tests on pierced/stacked
    squares. (2) #126 through the real menu: guess checked, guides dragged to measured
    positions, params, texture↔picture registration at 3 points, bleed, 5 steps,
    1-page PDF + footer, Re-fit. (2b) #118 (auto layout must be
    side-first/glue-left/straight) and #107 (pure auto-guess). (3) #110 as a gable
    regression. (4) backdrop → artwork. PDFs for #126/#118/#107 are written to
    `print/` (gitignored) for the physical test.
  - Still open: print + fold #126 and #118. Decorative cuts in pins (rounded tucks,
    notches) become straight cuts, as the dialog hint says.
- **2026-09-18** — **Carton from photo** (`BRIEF-photo-to-carton.md` steps 1–7; stretch
  goals not started). File → **Carton from photo…** opens `ui/PhotoCartonDialog.tsx`: the user
  clicks 8 corners on ONE carton in a 3/4-view picture (body "Y": bottom three L→R, top three L→R,
  then the two ridge ends above the front roof). Points stay draggable. The 9th point, the side
  gable peak, starts on the ridge end over the side (geometrically it sits there) and is drawn as a
  pink ring you can grab. Front = wider face by default, with a Left/Right toggle. Pure math is in
  `model/photoUnwarp.ts`: an 8×8 DLT homography with bilinear sampling unwarps the front face into
  the front+back body panels, the side face into both sides, and the front roof quad into both
  roofs. The side gable triangle is affine-warped into the gusset center triangles. Ribs and
  outer gusset triangles use the roof's median border color. Bottom and glue flaps are solid,
  using the median of the adjacent body edge (a stretched row printed as streaks). Every panel
  bleeds 2 mm (4-neighbour dilation). The quads are inset 1.2% to trim dark silhouette outlines.
  The output is one image covering `sheetBounds` exactly (row 0 = sheet max.y, confirmed in 3D),
  set as `material.overlayImage` (JPEG, 60 px/cm). Dims come from click proportions (foreshortening
  ignored on purpose). By default they're the largest size that fits one landscape Letter page
  (`fitLetterDims`, mirrors `dielinePDFTrueScale`'s margins), with presets for Fit Letter and
  250 mL mini, and a warning if the sheet would tile. `resolveDims` is now exported from `gable.ts`.
  `scripts/verify-v12.mjs` drives the real file chooser with the local-only Pinterest test image
  and 8 scripted clicks on the top-left carton, then checks: gable doc, sane dims, overlay
  front/back/side/roof/flap regions not background black, 3 fold steps, true-scale PDF = 1
  Letter page. Shots: `v12-wizard`, `v12-flat`, `v12-folded`, `v12-folded-upright`. The top-left
  carton builds at 8.1 × 4.0 × 11.7 cm (sheet 25.4 × 17.8 cm). Still open: a physical print + fold.
- **2026-07-12** — **Flat-mode rework + carton/gizmo/flicker fixes** (user, from screenshots:
  a rotated model shrank to a size they couldn't scale back; square-base carton felt the same as
  the tall one — wanted a real shorter 250 mL; selecting per-panel UV islands as the *default* in
  "UV mode" was confusing and not print-faithful; wanted **artwork-first** placement with an
  in-scene gizmo; rename UV mode → **Flat mode** where you can also edit the geometry to trace the
  artwork; a folded flap overlapped the design with z-fighting flicker; instructions/exported
  dielines should always include the textures/artwork).
  - **Scale-gizmo collapse fix** (viewer/ThreeView): world-space `TransformControls` scaling of a
    *rotated* object decomposed into wild/negative per-axis values that averaged to the 0.05 floor
    and couldn't recover. Now scale runs in **local space** (`setSpace('local')` for the scale
    tool) and `objectChange` averages **magnitudes**, clamps ≥0.05, and writes the uniform value
    back to the group — the model can shrink *and* grow again.
  - **Real carton sizes**: square-base template is now a genuine **250 mL squat** gable
    (`{width:5.7, depth:5.7, height:7.5}` cm — Pure-Pak mini standard, ~57 mm square base), the
    tall one relabelled **1 L (tall)**. Menu labels/titles note they are real standard sizes.
  - **UV mode → Flat mode**: `WorkspaceMode 'uv' → 'flat'`. The editor (still `ui/UVEditor.tsx`)
    is now a 3-tool segmented workspace (`.pe-toolset`): **Artwork** (default), **Geometry**,
    **UVs**. Artwork = the intuitive default: move/rotate/scale the design **overlay** with an
    in-scene gizmo (live SVG image, transform-driven so dragging never rebuilds the 2048px canvas),
    arrows nudge (`commitOverlay` coalesces), numeric fields + Auto-fit/Fill sheet. Geometry =
    the old geo-reshape, promoted to a first-class tool (pick panels, drag/gizmo → `setDoc`
    ops labelled "reshape …"). UVs = the old island editor (advanced; islands + numeric grid only
    here). `commitOverlay` gained a `coalesce` arg to mirror `commitUVEdits`.
  - **Z-fight fix** (viewer): face meshes get depth-keyed `polygonOffset` (deeper/later-folded
    panels pulled toward the camera by fold-tree depth) + `DoubleSide`, so a glue flap folded flat
    onto a body panel stops flickering.
  - **Artwork in instructions/exports**: `instructionsPDF`, `buildInstructionSheetHTML`,
    `openInstructionSheet`, the in-app Instructions preview, and the project bundle's dieline
    SVG/PDF all composite the printed design under the line work when the material has artwork.
  - **Verify**: `verify-v10` rewritten for Flat mode (default Artwork tool, tool switching,
    artwork-gizmo drag → `setOverlay`, geometry reshape, UV typing/gizmo/undo). New
    `scripts/verify-v11.mjs` (scale-gizmo-on-rotated recovery, 250 mL vs 1 L sizes differ,
    instructions/PDF carry artwork, depth-keyed polygon offsets). Full 15-script suite +
    typecheck green, zero page errors.

- **2026-07-12 (later)** — **UV editor feedback round** (user: scale field wouldn't accept 0.6 —
  couldn't clear the 1; UV moves had no undo/history; "Fit to dieline" didn't match the dieline;
  wanted an in-scene gizmo like fold mode; wanted a toggle to edit the actual mesh/geo so the
  object can be reshaped to match artwork instead of stretching art with text on it).
  - **Typed-scale fix**: shared `NumField` (ui/NumField.tsx) keeps a local draft while focused —
    a controlled number input snapped back to "1" on the intermediate ""/"0" keystrokes, which
    read as "only scales larger". Valid values apply live; blur/Enter restores canonical display.
    Scales guard `min 0.01`. Used by the UV inspector, Artwork section, and the Texture tool.
  - **UV history**: two new ops — `setUVs` (full prev/next UV-map snapshots) and `setOverlay`
    (artwork `overlayTransform`) — extend `EditableState` (like `doc`, undefined = unchanged).
    Drags stay transient and commit ONE op on pointer-up (`commitUVEdits` / `commitOverlay`);
    arrow-nudge runs coalesce into a single op; numeric fields commit on blur. Replay-based
    paths (revert-to-row, op delete) fall back to the first op's recorded `prev`. Texture-tool
    drags/fields in the dieline editor commit the same ops, so artwork placement is undoable
    everywhere. History rows read "UV: move islands", "Artwork: auto-fit artwork".
  - **In-scene gizmo** (`.uv-gizmo`): center square = free move, red/green axis arrows, ring =
    rotate (Shift snaps 15°), corner square = uniform scale — all group transforms about the
    selection pivot, computed from the gesture-start snapshot (no drift). Gotcha: SVG handles
    need `fill="transparent"`, not `none` — `none` isn't hit-testable and clicks fell through
    to the island below.
  - **⛭ Geometry mode**: the same drag/gizmo gestures move the selected panels' dieline
    VERTICES (`transformVertices` in editing.ts) instead of UVs — reshape the object to match
    the artwork. Live preview via `setDocTransient`, one undoable `setDoc` op per gesture
    ("UV geometry move/rotate/scale"). Shared vertices pull neighbouring panels (connected
    sheet); fold steps re-apply at the new shape. UV numeric fields hide in geo mode.
  - **Artwork fit**: "Fit to dieline" renamed **Fill sheet** (that's what it does); new
    **Auto-fit** detects the artwork's content box via `analyzeDielineImage` and maps it onto
    the sheet (trims background margins — the reason "fit" never lined up). Full panel-line
    registration remains the import wizard's job.
  - **Verify**: verify-v10 extended — char-by-char typing "0.6" into Scale V, drag → one
    `setUVs` op + undo/redo round-trip, gizmo scale-handle drag (>1.2×, correct label), geo-mode
    drag moves vertices + undo restores + uvEdits untouched, artwork field commit + auto-fit
    (scaleX 2 on a 50%-content test image) + undo. Also repaired two stale scripts broken since
    the 2026-07-10 top-menu round (not by this work): check-exports.mjs and check-sheet.mjs
    clicked sidebar buttons that moved into the File/Export menus. Whole suite + repro-crash +
    check-exports + check-sheet green, zero page errors.

- **2026-07-12** — **Mode menu + UV editor round** (user: "we wanted to avoid editing UV maps to
  keep dieline→printout fidelity, but at least allow *shifting* UVs so art lines up — add a top-menu
  **Mode** with fold / UV / instructions; UV mode = dieline-style view, select UVs, translate
  (mostly), rotate, maybe scale").
  - **Data model** (`model/uv.ts`): per-face `FaceUV { du, dv, rotationDeg, scaleU, scaleV }`
    applied about the face's base-UV centroid (`uv' = R·S·(uv−c) + c + d`; offsets are sheet
    fractions, rotation clockwise-on-screen to match the Texture tool). `uvEdits` map in the store,
    identity entries auto-pruned; persisted as `paperSim:uvEdits` (omitted when empty); NOT a
    history op (same policy as material/transform). Affine helpers (compose/invert) shared by all
    consumers.
  - **Fidelity preserved by construction**: `buildPrintCanvas` (viewer/texture.ts) inverse-warps
    the artwork per edited face — clip the face polygon in dieline px, `setTransform(F·T⁻¹·F⁻¹)`,
    redraw; out-of-artwork samples fall back to the base paper color. ALL artwork print paths now
    run through it (dieline PNG/SVG/PDF with artwork, true-scale 1:1 PDF), so shifting UVs never
    makes the printout diverge from the 3D preview. 3D (`ThreeView` UV attributes, live-refreshed
    on `uvEdits` change) and mesh exports (`bakeMesh` → OBJ/GLB/FBX) apply the same transform to
    UVs while keeping the base sheet texture.
  - **Mode menu** (TopBar): Fold mode (default workspace), UV mode, Instructions mode, with a
    check mark on the active one (`store.workspaceMode`). Fold-mode-only chrome (ViewBar, inset,
    timeline, pattern editor, QWER/123 hotkeys) hides in the other modes; ThreeView stays mounted
    underneath so capture keeps working.
  - **UV editor** (`ui/UVEditor.tsx`): artwork as fixed background, faint dieline reference, one
    selectable UV island per panel (selection = face selection, so the 3D view highlights too).
    Drag to translate (the workhorse), Ctrl+click multi-select, arrows nudge (Shift = coarse),
    numeric Offset U/V / Rotate / Scale U/V, group ⟲90/⟳90 + ±10% buttons, Reset selected /
    Reset all, Fit, wheel-zoom + right-drag pan. **Group semantics** (user feedback, same day):
    with several panels selected, the numeric fields apply the delta/factor relative to the
    primary panel about the SELECTION center — typing Scale 0.6 shrinks the whole selection as
    one piece (first cut scaled each island toward its own centroid, which read as "scales down
    separately"). Single selection = absolute per-face set. An **Artwork** section in the same
    inspector edits `overlayTransform` (offset/scale/rotate the design image itself + Fit),
    so both "move the UVs" and "move the art" live in UV mode.
  - **Instructions mode** (`ui/InstructionsView.tsx`): in-app instruction-sheet preview — dieline
    SVG + legend + one numbered snapshot card per step (offscreen captures from the live viewer),
    with Print-view and PDF buttons; friendly empty state when there are no steps.
  - **Verify**: new `scripts/verify-v10.mjs` (FaceUV math incl. clockwise 90° check, print-warp
    pixel assertions red→blue after du=0.5 + base-color fallback, bakeMesh UV shift, store prune +
    `paperSim:uvEdits` save/load round-trip + field omitted when clean, and real-UI checks: Mode
    menu switching, island drag updates `uvEdits` + selection, instruction cards = steps + 1).
    Whole suite verify…v10 green, zero page errors; visual smoke shots in `scripts/shots/v10-*`.
  - **Scope notes**: UV islands move rigidly per face (no per-vertex UV editing); UV edits skip
    undo history; the pattern editor's overlay reference still shows the base (unwarped) artwork —
    the UV editor itself is the truthful view for shifted panels.

- **2026-07-11 (evening)** — **Sleeves + Letter + vision round** (user shared the product vision:
  CAH-style free-designs/paid-materials, sleeves as expression like phone cases, education angle,
  eventual "Paperton" gallery/social layer — asked for a onesheet doc + basics).
  - **`VISION.md` onesheet**: pitch ("turn a standard printer into a 3D printer by folding"),
    sleeve wedge rationale, product pillars (preview never lies, Letter-first, foldable by
    construction, free designs/paid materials), product ladder, format-reality answer (jpg/png =
    wizard ✅, SVG = next, EPS/AI = convert via Inkscape/Ghostscript not a browser parser,
    CFF2/DXF = out of scope), Paperton parked with remix-lineage prep noted, anti-goals, open
    questions (laminate/velcro blanks, parody/trademark, kid-proof mode).
  - **US Letter everywhere**: all three PDF paths (true-scale, fit-preview dieline,
    instructions) now use 612×792 — an A4 sheet printed at 100% on Letter would have clipped
    ~5 cm. True-scale footer names the paper. Default 13 cm carton still fits one page.
  - **Sleeve templates** (`model/sleeve.ts`): rectangular open band W·D·W·D + glue seam, all
    vertical creases target 90°; File menu "New — Juice box sleeve" (5.5 × 4.3 × 7 cm, fits a
    200 ml brick with clearance) and "New — Can sleeve (12 oz)" (can-builder preset: 24 facets,
    r 3.45 → apothem 3.42 cm clears a Ø 6.6 cm can). Store template `'sleeve'` + one-step
    "Wrap the sleeve" fold.
  - **Verify**: new `scripts/verify-v9.mjs` (sleeve folds to exactly W×D×H, store round-trip,
    can-sleeve clearance math, Letter MediaBox + one-page true-scale). Whole suite verify…v9
    green, zero page errors.
  - **Next**: user prints + folds a sleeve/carton for real (physical feedback round), then SVG
    dieline import + fan folds.

- **2026-07-11 (latest)** — **Image → dieline round** (user: "most reference dielines are just
  jpgs/pngs — how can we get image → dieline going, with printouts matching expectations?
  Adjusting UVs to make it look right would be cheating").
  - **Diagnosis of the "wonky texture"**: two separable causes — (1) the raster has background
    margins but the overlay stretched the whole image over the whole sheet, and (2) the open
    project's template proportions didn't match the pictured carton, so panel seams can't align
    under ANY global stretch. Confirmed the fix is geometry-first, not UV remapping.
  - **`model/dielineImage.ts` analyzer**: foreground mask (alpha, else corner-sampled background
    color) → content box; body band = rows where the drawing spans full width; wall fold lines =
    column-gradient-energy peaks over the body band, best W·D·W·D(+glue) split chosen
    combinatorially; body top/bottom = strongest row-energy pair ≥35% height apart; gable corner
    line, per-column bottom-flap depths, glue width. Outputs scale-free `GableRatios`, a
    confidence (good/rough/none), and an `overlayTransform` that maps the content box exactly
    onto the sheet bounds (registration is exact by construction). NOT free-form vectorization —
    panel-grid estimation for a known archetype, per the roadmap decision.
  - **Import wizard** (`ui/ImportDielineDialog.tsx`, File → "Import dieline image…"): preview
    with detected box/lines drawn, "Body height (cm)" drives all dims proportionally (each
    editable), Build = `newDocument('gable', dims)` + registered overlay + project name from the
    file. Falls back gracefully (default carton + artwork fit) when no grid is found.
  - **Verified** (`scripts/verify-v8.mjs`): synthetic known-grid image recovered exactly
    (confidence `good`); real strawberry PNG → W=5.91 D=3.7 at H=13, overlay maps content box to
    exactly 0..1, carton builds + folds closed at those dims; end-to-end store path renders the
    textured dieline. Interactive smoke: wizard dialog → Build → folded carton renders with the
    label registered panel-per-panel. Whole suite verify…v8 green, zero page errors.
  - **Scope notes**: gable-carton archetype only (matches most drink-carton refs); depth-first
    (D·W·D·W) layouts and other archetypes (tuck box, sleeve, cup carrier) flag `rough` / fall
    back — extend by adding per-archetype grid models later. Photo-of-3D-product → dieline is
    still the separate v2 pipeline (VLM classify → parametric dims → unwarp artwork).

- **2026-07-11 (later)** — **Trustworthy reshape + print-ready PDF round** (user assessment session:
  "prioritize the dieline so people can print the PDF and fold it in real life"; reported the
  edge-ring move exploding the milk carton when shortening it).
  - **Exploding-carton fix**: ring drags/nudges moved only the ring's own vertices, shearing the
    gable panels above and invalidating their derived fold targets. New `ringRegionVertexIds`
    (`model/document.ts`) returns the ring vertices plus every vertex beyond the ring line along
    the reshape axis; both call sites (`ThreeView.beginReshape`, DetailsPanel nudge) now translate
    that whole region rigidly. Verified: shortening the rect gable by 3 keeps the folded
    cross-section exactly 5 × 3.2 and reduces length by exactly 3 (was: gable spikes / explosion).
  - **True-scale PDF export** (`dielinePDFTrueScale` in `ui/exports.ts`): 1 unit = 1 cm at 100%
    print scale, footer states the scale on every page, first page has a 5 cm calibration bar;
    auto orientation; sheets bigger than one A4 tile row-major with a gray trim frame and
    tile labels. Artwork variant draws the sheet texture under vector line work, embedding the
    JPEG once (shared XObject) regardless of tile count. Pdf writer gained rect/pushClip/pop and
    addImage/drawImage. Export menu: "Print-ready PDF — true scale 1:1" (+ artwork variant).
  - **Decisions recorded** (see Core decisions): no freeform UV editor (print fidelity is the
    product), 1 unit = 1 cm, photo→dieline = parametric-template pipeline not a trained model.
  - **Verify**: new `scripts/verify-v7.mjs` (shoulder-ring region > ring, cap edge lengths exactly
    preserved, folded closure at new height, store reshape undo, true-scale PDF single-page /
    tiled / artwork-embed-once). Whole suite verify…v7 green, zero page errors.
  - **Next per assessment**: SVG dieline import (PackCAD color mapping) + fan group-fold, then
    assisted raster-dieline trace, then the photo→template import wizard.

- **2026-07-11** — **Image→dieline, can template, textured export round** (user asked: fold a real
  dieline image — a strawberry-milk carton — plus a can, and export the artwork not just blank lines).
  - **Can / label template** (`model/can.ts`): a strip of N tall panels joined by vertical creases;
    each crease's target = 360/N so folding wraps the flat "label" into a regular N-gon prism
    (24 facets reads as a smooth cylinder). Optional glue seam. This is the "curve capability" the
    user wanted — the rigid hinge engine does it as many small folds, no new solver. New File-menu
    item "New — Can label (tube)"; `templateSteps` adds a "Roll into a cylinder" step.
  - **Parametric rectangular gable** (`buildGableCarton({width, depth, height, gable, rib, …})`):
    generalised the square-only builder. Worked out (and verify-checked) that the ridge/gusset fold
    is rigid for **any** width — every gusset/rib edge length is preserved; only the *depth* couples
    to the gable height (needs gable > depth/2). Roof width = W, gusset folds over depth D, ridge runs
    along W, gusset apex pulls inward by D/2 to `nx·(W−D)/2`, corners land on the ridge ends `nx·W/2`.
    Square carton unchanged (regression-checked). New menu item "New — Milk carton (tall/rect)"
    (W=5, D=3.2, H=13) — the strawberry-milk dieline folds via it and the artwork lands on the right
    panels almost perfectly (proportions match). Store `newDocument(template, dims?)` threads dims;
    `Template` gains `'can'`.
  - **Textured dieline export** (`ui/exports.ts`): `dielineTextureCanvas` composites the material's
    sheet texture (base + overlay art, source of truth = `buildSheetCanvas`) with the cut/crease line
    work on top; `dielineTexturePNG` (PNG blob), `dielineArtworkDataUrl` (art-only for crisp SVG),
    and `dielinePDF(doc, title, material?)` (now async; embeds the art). Export menu splits into
    "Dieline … (line art)" and "Dieline … — with artwork" (PNG/SVG/PDF). `verify-v4` updated for the
    now-async `dielinePDF`.
  - **Trace-backdrop tool** (`ui/PatternEditor.tsx` + `store.backdrop`): a **Trace** tool loads any
    saved dieline image behind the editor (drag to place, ± scale, opacity, Fit), so you can draw
    cuts/creases over an imported dieline. Session-only — cleared on new/load, not written to `.fold`
    (keeps files lean). This is the general "standardize my saved dieline examples" path for one-offs.
  - **Verify:** new `scripts/verify-v6.mjs` (can fold-to-tube closure, rectangular-gable proportions
    + square regression, textured PNG/SVG/PDF bytes, backdrop round-trip/clear, and the **real
    strawberry-milk PNG** mapping end-to-end as an overlay). Whole suite (verify … v6) green, zero page
    errors; visual smoke confirmed the can renders as a tube and the strawberry carton folds with its
    label mapped onto the panels.
  - **Follow-up fixes (same day, from user testing):** (1) the W/E/R gizmo/panel only ever acted on
    the whole object — added a **visible orange edge-ring move handle** in the 3D view (edge mode +
    Move tool + a selected ring) that drives the reshape; the whole-object `TransformControls` gizmo is
    now **suppressed in edge mode** so the two don't compete. (2) The right panel renamed "Transform" →
    **"Object transform"** and now shows the **"Edge ring"** section *first* (with "resizes the selected
    ring, not the whole object") whenever an edge ring is selected. (3) File menu clarified: the
    **tall/rect** milk carton (the shape printed cartons like the strawberry-milk dieline use) is listed
    first with a tooltip pointing at the Texture tool; the square carton is labelled "(square base)".
    verify-v6 gained edge-handle assertions (shown in edge mode, object gizmo hidden, hidden again in
    object mode). (4) **Edge-ring reshape now works on the folded model** (scrubbed to a step), not
    only the flat edit head — it's a pose-independent dieline edit, so the fold steps re-apply at the
    new size and it no longer "snaps back to flat." The whole-object gizmo + edge handle now show
    while a folded pose is displayed too (hidden only during active playback). Reshape onPointerDown
    moved above the edit-mode guard; `EdgeRingSection` nudges enabled unless actively playing.
  - **Scope notes:** the can is the tube/label only (no circular top/bottom disks — those need a
    rigid-disk fold; deferred). Image→dieline is template-match + Texture-fit (works today for the
    strawberry) or manual Trace; **automatic** line detection from a raster is still not attempted
    (unreliable without color-coded strokes). Artwork registration onto arbitrary dielines is manual
    via the Texture/UV tool. New mesh/dieline-with-art formats are in the Export menu but not added to
    the project-bundle zip.

- **2026-07-10 (night)** — **Maya-style tools round** (move/rotate/scale, top menu, mesh export,
  select modes, UV editor). Full plan in `~/.claude/plans/recursive-conjuring-wall.md`.
  - **Transform tools (Q/W/E/R):** unified whole-object `transform` in the store
    (`{ translate, rotateDeg, scale }`, replaces `objectRotation`; back-compat load of the old
    `paperSim:objectRotation`, saved as `paperSim:transform`). In-scene three.js `TransformControls`
    bound to the perspective view, driving new scene groups: `placementGroup(translate) >
    pivotGroup(auto-center) > orientGroup(rotate+scale) > modelGroup`. Numeric Move/Rotate/Scale
    fields + ±90° buttons in the right panel's **Transform** section, two-way bound to the gizmo.
  - **Select modes (1/2/3 = Object/Face/Edge):** `selectMode` in the store; ViewBar has tool +
    mode buttons. Edge mode adds per-edge invisible cylinder pick proxies (`edgeProxies`) that
    follow the fold; single-click selects an edge, **double-click selects the edge ring**
    (`edgeRing()` in `document.ts` — parallel edges sharing a perpendicular band; box/carton-tuned).
  - **Axis-constrained edge-ring reshape:** drag a selected ring with the Move tool (or use the
    right-panel **Edge ring** nudge fields) to move its dieline vertices along the ring's flat axis
    (`edgesAxis`/`edgesVertexIds` + `moveVertices` in `editing.ts`), refolding live via a new
    `setDocTransient` store action and committing one undoable `setDoc` op. Camera is preserved
    across the per-move rebuilds. This is how you change e.g. carton height.
  - **Top menu bar** (`ui/TopBar.tsx`): File / Edit / Export dropdowns; File+Export sections removed
    from the sidebar (slim **Project** section left behind). App shell is now a column
    (`.topbar` + `.app-body`).
  - **3D mesh export — OBJ + GLB + FBX, folded AND flat, textured:** `model/meshExport.ts` bakes each
    panel to a y-up, centered, ground-rested n-gon (single-sided; object transform intentionally not
    baked). `model/objExport.ts` (OBJ+MTL, zipped with the texture PNG), `ui/meshExport.ts` GLB via
    three's `GLTFExporter` (single textured file; V flipped for glTF UV origin), `model/fbxExport.ts`
    hand-written ASCII FBX 7400 (normals/UVs ByPolygonVertex, external texture ref, zipped when
    textured). Wired into the Export menu; iterated names via `nextExportName`.
  - **UV/texture editor:** `overlayTransform { offsetX, offsetY, scaleX, scaleY, rotationDeg }` on
    the material (identity = old full-stretch), applied in `viewer/texture.ts` (source of truth for
    the 3D texture + all PNG exports) and previewed in the dieline editor. New **Texture** tool in
    the pattern editor: drag the design to move it, plus a numeric **Texture / UV** inspector
    (offset/scale/rotate + upload + Fit-to-dieline).
  - **Verify:** new `scripts/verify-v5.mjs` (transform round-trip, edge-ring select, reshape+undo,
    OBJ/FBX bytes + bake, overlay-transform round-trip — all green); fixed `verify-v4.mjs`'s
    section-collapse proxy after the sidebar reshuffle; interactive smoke test confirmed the menu,
    a real GLB download, the W gizmo, and edge mode with zero page errors. Whole suite green.
  - **Deviations / scope notes:** edge-ring reshape + `edgeRing` are tuned for axis-aligned
    box/carton rings (skewed/curved rings, multi-axis free drags = future); the transform gizmo is
    interactive only in the perspective cell (renders in all four); FBX is byte-structure-verified
    but not yet imported into a real Blender/Maya; mesh formats are in the Export menu but NOT added
    to the project-bundle zip (kept the zip lean; individual exports cover it). Drag-scale/rotate
    handles for the overlay were left for later (numeric fields + drag-move cover fitting).

- **2026-07-10 (evening)** — **Workspace, materials, PDFs, template steps round**: side panels
  now drag-resize and collapse to labeled strips, every section collapses (all persisted in
  localStorage); Object controls moved to the right panel; Maya-style selection (double-click =
  row, Shift+double-click = column, triple-click = whole object, in 3D and the 2D inset);
  material system — base color / procedural kraft tile / uploaded texture (tiled) + design
  overlay stretched over the dieline (UVs = normalized flat coords, so the pattern editor shows
  exactly where art lands; overlay drawn in the editor as reference; persisted as
  `paperSim:material` data URLs, uploads downscaled to ≤2048px); dependency-free PDF writer
  (`ui/pdf.ts`: vector lines, Helvetica text, JPEG embedding) powering Dieline PDF + Instructions
  PDF exports (both also added to the project zip; per-format export counters); built-in
  templates now ship with 3 authored fold steps baked into the history base (open → press play;
  survives save/load; `model/templates.ts`). Dissected PackCAD's curved-box project
  (`assets/curved_box/`): their soft fold = fan of parallel creases, SVG colors black/red/yellow
  = cut/crease/soft — full notes + attack plan under "Soft folds" in the roadmap. New
  `scripts/verify-v4.mjs` (all checks pass); whole suite green.
- **2026-07-10 (later)** — **Projects & exports round**: project name field (persists as FOLD
  `file_title`, falls back to the file name on load), step renaming (already in v1 slice; kept),
  per-project iterated export names via localStorage counters (`carton_dieline_001.svg`, `_002`…,
  `carton_001.fold` — nothing ever overwrites), "Export project (zip)" bundle — dependency-free
  store-method zip writer (`ui/zip.ts`) packing a `projectname/` folder with the `.fold`
  (model + full history), dieline SVG, current-pose PNG snapshot, and the instruction-sheet HTML
  (snapshots inlined as data URLs). Desktop launcher: `launch-paper-sim.cmd` (starts dev server
  if down, waits, opens browser) + generated `paper-sim.ico` + a "Paper Sim" shortcut on the
  Desktop (shortcut itself is machine-local, not in the repo). New verify:
  `scripts/check-exports.mjs` (download names iterate, zip entries correct + extractable by
  Windows, project-name round-trip). All seven verify scripts pass.
- **2026-07-10** — **First v1 slice built and verified** (user request round after milk-carton
  session): gable-top milk carton template (square base; spout gusset diagonals; all 22 hinge
  targets derived from the sealed pose via dihedral math — closure verified numerically to ~1e-3),
  Ctrl+click group folding (`setAngles` op; % slider + gizmo drives group), dieline editor mode
  (draw/delete/retype/move lines; face split/merge; undoable `setDoc` ops carrying full doc
  snapshots, replayed through history — `baseDoc` tracks the pre-history dieline), whole-object
  rotation + auto-centering ground-rest pivot, generic FOLD import, dieline SVG export,
  instruction-sheet export (printable HTML; offscreen WebGL captures per step).
  **Crash fix**: step re-edit + history surgery + undo/redo could duplicate step IDs (React
  duplicate-key → broken steps UI, matches user's crash report); `applyOp`/`revertOp` now dedupe
  by step id. New scripts: `verify-v3.mjs` (closure math, editing, import, regression),
  `repro-crash.mjs`, `check-sheet.mjs`, `shoot-v3.mjs`; all verify scripts take `PAPERSIM_URL`.
  Deferred from this round: fold arrows on the instruction sheet, SVG dieline import, free-angle
  object rotation (only 90° steps), and a kinematic coupling solver (group folds are
  target-proportional, not constraint-solved).

- **2026-07-10** — **Pushed to GitHub**: https://github.com/lucyellu/paper-sim (initial commit on
  `main`; source + docs only, heavy/private reference media gitignored). Added "Picking up in a
  new session" section above.
- **2026-07-10** — **v0.5 UX round built and verified** (user feedback after first session):
  timeline notches + step re-edit/continue actions, F-to-frame, suggested-angle preset tinting
  driven by new `targetAngles` dieline metadata (persisted as `paperSim:targetAngles`),
  gizmo soft-snap (verified: quarter-turn ring drag lands exactly on 90°; Alt-free gives 73.1°),
  quad viewport (persp/top/front/side with per-view controls), dark mode, right-hand Details
  panel with per-op history (revert-to-row, single-op delete, delete non-deformer, bake).
  New dev hooks for testing: `window.paperSim` (store) and `window.paperSimViewer` (gizmo/views);
  robust gizmo test computes ring screen position instead of guessing pixels.
  Note: single-op delete is "history surgery" — later ops replay against the recomputed state,
  so a later op's recorded `prev` may no longer match; acceptable, documented here.
- **2026-07-10** — **v0 built and verified.** App lives in `app/` (Vite + TS + React + three.js +
  zustand). All v0 checklist items done. Verified via Playwright driving the real app
  (`app/scripts/verify.mjs`, `verify-gizmo.mjs` — dev server must be running): carton folds into
  a closed box via 2 keyframes, scrub/playback interpolates, click-select works, real mouse drag
  on the gizmo ring folds live and commits one op, undo/redo works, save→load round-trip
  preserves state AND undo history (rename reverts after load), Delete History bakes.
  Screenshots in `app/scripts/shots/`. Known v0 limits: selection highlight in 3D is subtle;
  folded model pivots around the root panel (box ends up lying on the sheet plane — no
  auto-rest-on-ground yet); no crease editing (fixed carton dieline); window.confirm dialogs.
- **2026-07-10** — History design upgraded to event-sourced document per user request: op log
  persists in save file (undo survives loads), per-object history views, Maya-style
  "Delete History" bake (project-wide v0, per-object v1).
- **2026-07-10** — Project scoped over discussion. All core decisions above recorded. STATE.md
  created. Next action: v0 scaffold.
