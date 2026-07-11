# Paper Sim — Project State

> Living document. Records the plan, decisions, and progress. Update whenever a decision is made,
> a milestone lands, or scope changes. Newest progress-log entries go on top.

**Status:** v0 + v0.5 + first v1 slice complete and verified — app in `app/`, run with `cd app && npm run dev`
**Repo:** https://github.com/lucyellu/paper-sim (branch `main`)
**Last updated:** 2026-07-10

## Picking up in a new session

1. Read this file top to bottom (decisions → architecture → roadmap → progress log).
2. `cd app && npm install && npm run dev` → http://localhost:5173 (`app/README.md` has controls).
3. Verify the world still works: with the dev server running,
   `node scripts/verify.mjs && node scripts/verify-gizmo.mjs && node scripts/verify-v2.mjs && node scripts/verify-v3.mjs`
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
- [ ] Per-hinge angle limits (basic constraints)
- [ ] Animation export (GIF/MP4)
- [ ] Starter model library from `reference/` (gift box, cup, boat, peacock…)
- [ ] History panel: per-object filtered op list, per-object Delete History (compaction)
- [ ] Micro-crease fan tool / soft folds (see "Soft folds" note below) — unlocks the can shape,
      curved box, and the lucky star
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
