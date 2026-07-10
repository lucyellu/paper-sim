# Paper Sim (v1)

Web-based paper-folding sandbox. See `../STATE.md` for the full plan, decisions, and progress.

## Run

```sh
npm install
npm run dev     # http://localhost:5173
```

## Use

- **New: Box / New: Milk carton** — starter dielines. The milk carton is a gable-top with the
  spout gusset creases (diagonals on the side tops); every crease carries the target angle that
  seals the carton, derived from the sealed 3D pose.
- **Click a panel** (3D view or 2D pattern inset) to select it; drag the **orange ring** to fold
  along its hinge. The ring soft-snaps near preset/target angles (Alt = free, Shift = 15° grid);
  the sidebar has slider/number input plus preset buttons tinted by how close they are to the
  model's intended fold angle.
- **Ctrl+click** adds panels to the selection to **fold them together**: the sidebar shows a
  0–100% "fold toward targets" slider (each crease moves toward its own target — this is how the
  gable top folds inward as one), and the gizmo ring drives the whole group.
- **Object** section rotates the whole model in 90° steps (e.g. stand the carton upright). The
  model always re-centers over the world origin and rests on the ground plane.
- **✎ (top right)** opens the **dieline editor**: draw creases/cuts (endpoints snap to points and
  lines; drawing across a panel splits it), delete lines between panels (merges them), click a
  line to retype it (cut ↔ crease) or set its target angle, drag points to move them. All edits
  are undoable history ops.
- **Export** — *Dieline SVG* downloads the flat pattern (cuts solid, valley/mountain dashed);
  *Instruction sheet* opens a printable page with the dieline plus one numbered 3D snapshot per
  fold step (print to PDF from the browser).
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
node scripts/shoot-v3.mjs      # visual pass: carton fold sequence + editor screenshots
```

Screenshots land in `scripts/shots/`.
