# Paper Sim (v1)

Web-based paper-folding sandbox. See `../STATE.md` for the full plan, decisions, and progress.

## Run

```sh
npm install
npm run dev     # http://localhost:5173
```

Or double-click `..\launch-paper-sim.cmd` (the "Paper Sim" desktop shortcut points at it) — it
starts the dev server if it isn't running and opens the app in the browser.

## Use

- **File → New** — starter dielines: tuck box, milk carton (square or **tall/rect** gable), and a
  **can label** (faceted cylinder — the label rectangle wraps into a tube via a fan of creases).
  The milk carton is a gable-top with spout gusset creases; every crease carries the target angle
  that seals it. Templates come with their fold steps recorded — press **play** to watch them fold.
- **Transform tools** — `Q`/`W`/`E`/`R` = select / move / rotate / scale (in-scene gizmo + numeric
  fields, right panel). `1`/`2`/`3` = Object / Face / **Edge** select mode. In Edge mode,
  double-click an edge to select its whole ring, then drag the **orange arrow** (or use the Edge
  ring nudge fields) to resize the model — works on the folded model too (it's a dieline edit).
- **Click a panel** (3D view or 2D pattern inset) to select it; drag the **orange ring** to fold
  along its hinge. The ring soft-snaps near preset/target angles (Alt = free, Shift = 15° grid);
  the sidebar has slider/number input plus preset buttons tinted by how close they are to the
  model's intended fold angle.
- **Ctrl+click** adds panels to the selection to **fold them together**: the sidebar shows a
  0–100% "fold toward targets" slider (each crease moves toward its own target — this is how the
  gable top folds inward as one), and the gizmo ring drives the whole group. **Double-click**
  selects a panel's whole row, **Shift+double-click** its column, **triple-click** the entire
  object (works in 3D and in the 2D inset).
- **Panels & sections**: drag a side panel's inner edge to resize it, use the ⟨/⟩ button to
  collapse it to a strip, and click any section header to fold it shut — the layout is
  remembered.
- **Object** section (right panel) rotates the whole model in 90° steps (e.g. stand the carton
  upright). The model always re-centers over the world origin and rests on the ground plane.
- **Material** section (right panel): base look (plain color, procedural kraft paper, or your
  own texture image, tiled) plus a **design overlay** stretched over the dieline — the flat
  pattern is the object's UV map, exactly like a product mockup. The overlay is shown in the
  dieline editor so you can line art up with panels. Saved inside the `.fold` file.
- **Mode** (top menu) switches the workspace: **Fold mode** (default — everything below),
  **UV mode**, and **Instructions mode**. UV mode is a Blender-style UV editor: the artwork is the
  fixed background, each panel's **UV island** sits on top — drag an island to choose which part
  of the artwork that panel shows (Ctrl+click multi-select, arrow keys nudge, numeric
  offset/rotate/scale in the inspector; translate is the workhorse). With several panels
  selected, fields and buttons act on the selection **as one piece** about its center. The
  inspector's **Artwork** section moves/scales the design image itself (same as the Texture
  tool). Islands default to the dieline exactly; **print exports warp the artwork back per
  panel**, so the printout always matches the 3D preview. UV edits are saved in the `.fold`
  file (`paperSim:uvEdits`).
  Instructions mode previews the instruction sheet in-app (dieline + numbered step snapshots)
  with Print / PDF buttons.
- **✎ (top right)** opens the **dieline editor**: draw creases/cuts (endpoints snap to points and
  lines; drawing across a panel splits it), delete lines between panels (merges them), click a
  line to retype it (cut ↔ crease) or set its target angle, drag points to move them. All edits
  are undoable history ops. Two extra tools: **Texture** (fit a printed design onto the panels —
  drag/offset/scale/rotate the overlay) and **Trace** (drop a reference dieline image behind the
  editor and draw the cut/crease lines over it; the backdrop is a guide, not saved).
- **Project name** (File section) names your work; fold steps can be renamed in the steps list.
  Exports are numbered per project — `carton_dieline_001.svg`, `_002`, … — so nothing overwrites.
- **Export** (top menu) — *Dieline SVG / PDF* line art (cuts solid, valley/mountain dashed; PDF is
  true vector), and *Dieline PNG / SVG / PDF — with artwork* (the printed design composited under
  the lines); *Instructions* (printable page + PDF) with the dieline plus one numbered 3D snapshot
  per fold step; **3D mesh — OBJ / GLB / FBX** in folded and flat poses, textured, for
  Maya/Blender/Roblox; *Project bundle (zip)* — a `projectname/` folder with the `.fold` (model +
  history), dieline SVG + PDF, a pose snapshot, and the instructions HTML + PDF.
- **F** frames the selected panel in all views; with nothing selected it frames the whole model.
- **Add Keyframe** records the current pose as the next fold step. The timeline shows a numbered
  notch per step — click one to select it, then ✎ re-edit (re-record) or ⏵ continue after it.
  Steps are strictly linear; both actions delete later steps (with confirmation).
- **Undo/redo** (Ctrl+Z / Ctrl+Y) covers all authoring actions incl. dieline edits; history is
  saved inside the `.fold` file, so undo still works after Save → Load. The right-hand **History
  panel** lists every action — click a row to revert/redo to that point, ✕ deletes a single
  action, "Delete non-deformer" drops renames, "Delete all (bake)" clears history Maya-style.
- **⊞ toggle** (top right) switches single / quad view (perspective + ortho top/front/side);
  **🌙** toggles dark mode.
- Files are standard [FOLD](https://github.com/edemaine/fold) JSON with `paperSim:*` extensions.
  **Load** also imports plain FOLD files from other tools (needs `faces_vertices`; authored
  `edges_foldAngle` become target angles).

## Verify (headless smoke test)

With the dev server running (`PAPERSIM_URL` overrides the default `http://localhost:5173/`):

```sh
node scripts/verify.mjs        # folds the carton, tests steps/undo/save-load round-trip
node scripts/verify-gizmo.mjs  # real pointer drag along the gizmo ring + snap check
node scripts/verify-v2.mjs     # timeline notches, history panel surgery, quad view, dark mode
node scripts/verify-v3.mjs     # gable closure math, group folds, dieline editing, FOLD import
node scripts/repro-crash.mjs   # step re-edit / history-surgery stress (duplicate-id regression)
node scripts/check-sheet.mjs   # instruction-sheet popup + group-fold UI
node scripts/check-exports.mjs # numbered export names, PDFs, project bundle zip, name round-trip
node scripts/verify-v4.mjs     # template steps, row/column/object selection, materials, panels
node scripts/verify-v5.mjs     # transform round-trip, edge-ring select + reshape, OBJ/FBX bytes
node scripts/verify-v6.mjs     # can + rectangular-gable geometry, textured export, edge handle
node scripts/verify-v7.mjs     # edge-ring region reshape, true-scale 1:1 PDF export
node scripts/verify-v8.mjs     # image → dieline analyzer + import wizard
node scripts/verify-v9.mjs     # sleeve templates, can-sleeve clearance, US Letter pages
node scripts/verify-v10.mjs    # Mode menu, UV editor (drag/select), print warp, uv save/load
node scripts/shoot-v3.mjs      # visual pass: carton fold sequence + editor screenshots
```

Screenshots land in `scripts/shots/`.
