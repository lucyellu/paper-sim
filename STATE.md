# Paper Sim — Project State

> Living document. Records the plan, decisions, and progress. Update whenever a decision is made,
> a milestone lands, or scope changes. Newest progress-log entries go on top.

**Status:** v0 + v0.5 complete and verified — app in `app/`, run with `cd app && npm run dev`
**Repo:** https://github.com/lucyellu/paper-sim (branch `main`)
**Last updated:** 2026-07-10

## Picking up in a new session

1. Read this file top to bottom (decisions → architecture → roadmap → progress log).
2. `cd app && npm install && npm run dev` → http://localhost:5173 (`app/README.md` has controls).
3. Verify the world still works: with the dev server running,
   `node scripts/verify.mjs && node scripts/verify-gizmo.mjs && node scripts/verify-v2.mjs`
   (all logic checks should pass with no page errors; screenshots land in `app/scripts/shots/`).
4. Next milestone is **v1** (below). The user hasn't picked the first v1 slice yet — top
   candidates are instruction-sheet export (cheap, differentiating) or the crease-pattern editor.
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
- [ ] Crease-pattern / dieline editor (draw cuts + creases on flat sheet); SVG import
- [ ] Per-hinge angle limits (basic constraints)
- [ ] Materials: paper color/texture both sides, artwork mapping
- [ ] Instruction-sheet export (numbered snapshots + fold arrows, SVG/PDF)
- [ ] Animation export (GIF/MP4)
- [ ] Starter model library from `reference/` (carton, gift box, cup, boat, peacock…)
- [ ] History panel: per-object filtered op list, per-object Delete History (compaction)
- [ ] Micro-crease fan tool (approximate curved bends) — unlocks the lucky star
- [ ] Cozy UI pass per `reference/GUI/`

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
