# Brief: Pinterest dieline → fitted, foldable, print-ready box ("fit-the-grid" importer)

**Goal:** give the app a flat dieline picture from Pinterest (a printable box template), let the
user **drag a template grid onto it** to verify the fit, see it fold in 3D, and print it
**for real**: true-scale US Letter, and it folds into a box that looks like the picture.
The drag-to-fit step is a feature. It's the interactive "check before you print" moment.

The long-term aim is "any dieline" (egg cartons, mini vending machines…), so this brief
builds an **archetype registry** where each new box type is one module. This round ships
**tuck-end boxes + gable cartons** plus a manual **trace-anything** escape hatch.

> Sibling work: `BRIEF-photo-to-carton.md` (3D photo → carton) may have landed just before
> this. Check `git log` and `ui/TopBar.tsx` first, and don't clobber it. Its verify script is
> `verify-v12.mjs`, so use `verify-v13.mjs` here.

## Context (read these; skip the full STATE.md)
- Pillar: **geometry always comes from a parametric builder** (guaranteed foldable). The
  image supplies only measurements and artwork. Never vectorize free-form lines from raster art.
- `model/gable.ts` — `buildGableCarton(dims)`: the pattern to copy. Flat layout in cm (y up),
  `addPoly` builder, 3D sealed-pose target positions → `deriveTargetAngles` (`model/targets.ts`).
- `model/carton.ts` — the old **hardcoded** tuck carton (fixed W=6 D=4 H=12). Replace it with a
  parametric one and keep `buildCarton()` working for old files and templates.
- `model/templates.ts` — templates ship authored fold steps. New builders need steps too.
- `model/dielineImage.ts` + `ui/ImportDielineDialog.tsx` — today's **gable-only** importer:
  auto-detects fold lines (`vLines`, `hBody`) and produces an `OverlayTransform` that registers
  the image onto the sheet. Reuse the detection as the *initial guess* only.
- Artwork: `material.overlayImage` + `overlayTransform` (fractions of `sheetBounds(doc)`),
  drawn in `viewer/texture.ts buildSheetCanvas`. Print: `dielinePDFTrueScale` in `ui/exports.ts`.
- Trace backdrop: `store.backdrop` (session-only image behind the dieline editor, with
  position/scale in flat coords). Used in step 5.
- Tests: `app/scripts/verify-v*.mjs` (playwright, `window.paperSim` store hook), `npx tsc --noEmit`.

## Test set (`reference/dieline/`, local-only, gitignored)
| File | What it exercises |
|---|---|
| `pinterest_4081455908182783.jpg` (#118 Hello Kitty juice) | horizontal; side-panel-first order; glue on LEFT; straight tuck (both lids on same panel) |
| `pinterest_4081455908182793.png` (#126 cherry cloud) | vertical; reverse tuck; glue on right; clean background |
| `pinterest_4081455908182739.png` (#83 Outcast) | layout rotated 90°; needs rotate step |
| `pinterest_4081455908182770.jpg` (#107 salted butter) | long narrow box; tapered dust flaps; low resolution |
| `pinterest_4081455908182773.png`, `…785.jpg` (gable milk) | regression: gable still imports via the new wizard |
Also worth trying: `…760`, `…780`, `…787` (BMO), `…796`, `…797`.

## Build, in order

### 1. Parametric tuck-end box — `model/tuck.ts`
`buildTuckBox(p: TuckParams): PaperDoc` with
`{ width, depth, height, lid?, tuck?, dust?, glue?, style: 'straight'|'reverse', order: 'front-first'|'side-first', glueSide: 'right'|'left' }`.
- Body: 4 panels in a row (wide W, narrow D alternating per `order`) + glue flap on `glueSide`.
- Top: a **lid** (height = D) on one wide panel + a **tuck tongue** beyond it (default ~1.5 cm,
  small chamfered corners), and **dust flaps** on both narrow panels (default ~0.6·D, tapered
  outer edge). Bottom: the same. `straight` = both lids on the same wide panel; `reverse` = the bottom lid
  sits on the opposite wide panel.
- Sealed-pose 3D targets like gable.ts: dust flaps fold 90° in, lid folds 90° over them, tuck folds
  90° down inside the opposite wall → `deriveTargetAngles`. Add a template with fold steps
  (dust flaps → lids → tucks) and "New — Tuck box" presets in the File menu.
- `buildCarton()` can become `buildTuckBox(<old constants>)` if the output stays compatible;
  otherwise leave it alone.

### 2. Archetype registry — `model/archetypes.ts`
```ts
interface Archetype<P> {
  id: 'tuck' | 'gable' // extend later: egg, pillow, carrier, vending…
  label: string
  defaults: P
  build(p: P): PaperDoc
  /** Named fit guides in FLAT coords (cm): vertical x-lines + horizontal y-lines the user drags. */
  guides(p: P): { x: Guide[]; y: Guide[] }
  /** Inverse: guide positions (flat cm) → params (e.g. W = mean of wide columns). */
  fromGuides(g: GuidePositions, prev: P): { params: P; mismatch: number /* 0..1, W/D repeat error */ }
}
```
Register tuck and gable. Adding the next box type later should mean one new module, with no wizard changes.

### 3. Fit-the-grid wizard — replace `ImportDielineDialog` (keep File → "Import dieline image…")
1. **Prep**: drag a crop rectangle (many pins show the flat next to a mockup); rotate 90° / flip
   buttons. Bake the result to a new canvas, and all later steps use that image.
2. **Archetype + layout**: pick tuck (straight/reverse) or gable; toggles for side-first order
   and glue left/right. Pre-guess them from the existing analyzer when it has confidence.
3. **Fit**: draw the archetype's flat outline (cut = solid, crease = dashed) **over the image**, and
   make every guide line draggable: the column boundaries plus the horizontal rows (bottom-flap edge,
   body bottom, body top, lid top, tuck top). Also a move/scale handle for the whole grid.
   Initial placement comes from the analyzer (`vLines`/`hBody`), else evenly spaced inside the
   content box. Show the `mismatch` warning when the picture's W/D columns don't repeat.
4. **Size**: one real-size input (body height in cm; everything else scales). Presets:
   **"Fit one Letter page"** (largest size whose sheet fits landscape or portrait Letter minus
   margins) and **"Sharpest print"** (size at which the art is ≥150 dpi).
   Show the **effective print DPI** live (image px per cm × 2.54) with a warning below 150,
   because the goal is printing for real and many pins are small.
5. **Build**: `newDocument` with the archetype's params; set the material overlay so image pixels
   land exactly where the guides said. The mapping is affine (image px ↔ flat cm from two x-guides
   + two y-guides), converted into the `OverlayTransform` fractions of `sheetBounds`.
   **Verify the y-axis orientation** against how the current importer registers art. Keep the
   wizard state (image, crop, guides) in the store for the session so **"Re-fit…"** can reopen it
   after checking the 3D fold.
6. Decorative cut shapes in the picture (rounded tucks, thumb notches) won't match our straight
   cuts exactly. Accept that for now. Note it in the dialog hint ("cut along the printed lines").

### 4. Print-for-real checks
- The true-scale artwork PDF must come out as **one Letter page** at the chosen size.
- Paint a ~2 mm **bleed** past the cut outline (extend edge pixels) so a slightly-off cut shows no white.
- The instruction sheet / PDF footer states the size, the DPI, and "print at 100%, cut solid, score dashed".

### 5. Trace-anything escape hatch (any shape, today)
For pictures that fit no archetype (vending machine, egg carton, hexagon box): the trace-backdrop
tool already lets the user draw cuts and creases over the picture. Add **"Use backdrop as artwork"**:
register the backdrop into `material.overlayImage` with the same flat-coords mapping, so a hand-traced
dieline prints with its art. Target angles are then set by hand in the editor, as today.

## Out of scope (future archetypes, one module each)
Egg carton (cells need fan folds / curved creases), pillow box (curved creases), mini vending
machine (multi-part + window cut-outs; check whether faces support holes), cup carrier, hexagon box.
AI-assisted guide placement (vision model pre-places the guides). The rules-based guess is enough for now.
A thumbnail gallery of built boxes (save `.fold` files to a local folder + File → "Open from library").

## Copyright
These pins are other people's designs. Folding and printing them for personal use and testing is fine.
**Never commit the images or `.fold` files built from them.** Keep them under gitignored folders
(`reference/`, `print/`).

## Verify
`app/scripts/verify-v13.mjs`: build tuck boxes (straight + reverse, both orders, both glue sides)
and assert they fold to exactly W×D×H with no panel overlaps at the sealed pose. Drive the wizard on
#126 with scripted guide positions and assert params, overlay registration (sample the canvas at the
front-panel center ≈ the picture's front-panel center color), and a one-page PDF. Re-run the gable
import on #110 as a regression check. Screenshot each folded result to `scripts/shots/`. Run `npx tsc --noEmit`.
Then the human prints #126 and #118 and folds them. That's the real acceptance test.

## Done =
#118, #126, #83 and #107 each: crop/rotate → drag-fit in under a minute → folds in 3D → one-page
Letter PDF → a real printed box that looks like the pin. Commit; add a STATE.md progress-log entry
and a VISION.md note (archetype registry = how "any dieline" grows).
