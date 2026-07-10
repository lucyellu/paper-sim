# Paper Sim (v0)

Web-based paper-folding sandbox. See `../STATE.md` for the full plan, decisions, and progress.

## Run

```sh
npm install
npm run dev     # http://localhost:5173
```

## Use

- **Click a panel** (3D view or 2D pattern inset) to select it; drag the **orange ring** to fold
  along its hinge. The ring soft-snaps near preset/target angles (Alt = free, Shift = 15° grid);
  the sidebar has slider/number input plus preset buttons tinted by how close they are to the
  model's intended fold angle.
- **F** frames the selected panel in all views; with nothing selected it resets the views.
- **Add Keyframe** records the current pose as the next fold step. The timeline shows a numbered
  notch per step — click one to select it, then ✎ re-edit (re-record) or ⏵ continue after it.
  Steps are strictly linear; both actions delete later steps (with confirmation).
- **Undo/redo** (Ctrl+Z / Ctrl+Y) covers all authoring actions; history is saved inside the
  `.fold` file, so undo still works after Save → Load. The right-hand **History panel** lists
  every action — click a row to revert/redo to that point, ✕ deletes a single action,
  "Delete non-deformer" drops renames, "Delete all (bake)" clears history Maya-style.
- **⊞ toggle** (top right) switches single / quad view (perspective + ortho top/front/side);
  **🌙** toggles dark mode.
- Files are standard [FOLD](https://github.com/edemaine/fold) JSON with `paperSim:*` extensions.

## Verify (headless smoke test)

With the dev server running:

```sh
node scripts/verify.mjs        # folds the carton, tests steps/undo/save-load round-trip
node scripts/verify-gizmo.mjs  # real pointer drag along the gizmo ring + snap check
node scripts/verify-v2.mjs     # timeline notches, history panel surgery, quad view, dark mode
```

Screenshots land in `scripts/shots/`.
