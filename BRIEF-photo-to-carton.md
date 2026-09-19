# Brief: Photo → foldable carton ("Carton from photo…")

**Goal (tonight, a few hours):** give the app a picture of a 3D gable-top milk carton
(e.g. a Pinterest render) and get back a true-scale, printable, foldable dieline PDF whose
artwork makes the folded result *look like the picture*. This is the demo that sells the
project: picture in → real object out.

Test image: `reference/dieline/pinterest_4081455908182799.jpg` (4 cartons in 3/4 view on
black; front = wide labelled face on the RIGHT, side = narrower face on the LEFT, gable roof
with a cap on top). Gitignored, local only.

**Don't re-read STATE.md in full.** Everything you need is below. Budget matters: execute and don't explore.

## Why this is tractable
Geometry is solved: `buildGableCarton(dims)` in `app/src/model/gable.ts` is a parametric,
guaranteed-foldable gable carton with authored target angles. The true-scale Letter PDF
with artwork already exists (`dielinePDFTrueScale(doc, name, material, uvEdits)` in
`app/src/ui/exports.ts`; picks landscape/portrait, tiles if needed). The 3D preview already
textures the carton from `material.overlayImage`. **The only missing piece is: 3D photo
faces → flat panel artwork.** Never generate geometry from the image (VISION.md pillar).

## Flat layout of the gable dieline (units = cm, y up, from gable.ts)
Columns along x: front `[0,W]`, right side `[W,W+D]`, back `[W+D,2W+D]`,
left side `[2W+D,2W+2D]`, glue flap `[2W+2D, 2W+2D+GLUE]` (body height only).
Rows along y: bottom flaps `[-BOT, 0]` (BOT_FB=2.2 for front/back cols, BOT_LR=1.8 for sides),
body `[0,H]`, roof (front/back cols) or gusset (side cols) `[H, H+G]`, rib `[H+G, H+G+R]`.
Defaults: G = 0.75·D, R = 0.9, GLUE = 1.2. Side gusset = triangle (x0,H)-(x0+D,H)-(x0+D/2,H+G)
(center, folds inward to form the recessed triangle you see on real cartons) + two outer
triangles that ride up with the roofs; side ribs split into halves.
Sheet bounds come from `sheetBounds(doc)` in `model/document.ts`.

## How artwork reaches the sheet
`MaterialSettings.overlayImage` (data URL) is stretched across the full sheet bounds when
`overlayTransform` is identity/undefined (`viewer/texture.ts buildSheetCanvas`). So:
**compose one canvas covering sheetBounds at ~60 px/cm, paint each panel's artwork into its
flat rect, then `setMaterial({...defaultMaterial(), baseColor, overlayImage: canvas.toDataURL()})`.**
⚠ Verify the y orientation first (does canvas row 0 = sheet max.y?). Check how
`ImportDielineDialog` / `dielineImage.ts` overlay lines up, or paint a test canvas with
the "FRONT" label in the front-body rect and look at the 3D view. Get this right before anything else.

## What to build
New dialog `app/src/ui/PhotoCartonDialog.tsx`, opened from the File menu in `ui/TopBar.tsx`
("Carton from photo…"), wired the same way as `ImportDielineDialog` (see TopBar ~line 350).
Pure math in a new `app/src/model/photoUnwarp.ts` (homography + compositing, testable).

1. **Load image** and show it large in the dialog (fit to ~700 px, remember the scale factor).
2. **Guided corner clicks** on ONE carton (the image may contain several). Prompt text tells
   the user what to click next, and the points stay draggable afterwards. 8 points:
   - body "Y": left-face bottom-left, shared bottom corner, right-face bottom-right,
     then the same three at the top of the body (where the roof starts);
   - roof: the two ridge ends above the front face (the ridge is the top edge of the roof
     slope, just under the rib/seal);
   - optional 9th: gusset apex on the side face (default = side-top-midpoint + up by the
     roof rise).
   A toggle sets which visible face is the FRONT (default = the wider one).
   Draw the quads over the image as the user goes.
3. **Unwarp** each quad with a 4-point homography (solve the 8×8 system, inverse-map with
   bilinear sampling into an offscreen canvas):
   - front body quad → front AND back body panels (copy);
   - side body quad → right AND left side panels;
   - front roof quad (body-top-left, body-top-right, ridge-right, ridge-left) → front and back roofs;
   - side gusset triangle → side gusset center triangles (affine is fine here).
4. **Bleed / fill** (this is what makes the print look good): ribs = roof's dominant color;
   bottom flaps + glue flap = the adjacent body panel's edge color, stretched or solid;
   outer gusset triangles = roof color. Extend each panel ~2 mm past its edges so a
   slightly-off cut doesn't show white. Dominant color = median of the panel's border pixels.
5. **Dimensions**: prefill fields (W, D, H in cm) from the click proportions. Use
   front-quad height/width averaged across the two opposite edges, side width relative to
   front width, and treat foreshortening as good enough. The height field scales everything.
   Preset buttons: "250 mL mini (5.7×5.7×7.5)" and "fit Letter". Must fit ONE landscape
   Letter page (27.9×21.6 cm usable ≈ 26×19.5 after margins). Show a warning if it won't.
   Keep `gable ≥ 0.51·depth` (see `gableDimsFromAnalysis` for the clamp).
6. **Build**: `newDocument('gable', dims)`, set the project name, set the composed material.
   Same pattern as `ImportDielineDialog.build()`. The carton should appear textured in 3D,
   and the template's fold steps should play it from flat to folded.
7. **Export**: existing Export → true-scale PDF with artwork must produce a single
   Letter page. Just confirm it does.

## Stretch goals (only if 1–7 are done and verified)
- **"Coloring page" print mode**: B&W line-art version of the composed artwork (grayscale →
  edge detect / threshold, black outlines on white). The user's printer is B&W, and
  "print it and color it yourself" is a kid-friendly feature. Add it as a checkbox in the dialog
  that swaps the overlay.
- **Auto-place corners with Claude vision** (claude-fable-5-1 / claude-sonnet-5, browser call with
  `anthropic-dangerous-direct-browser-access`, key from a local input, never committed).
  Treat it as a starting guess only, because the user adjusts the handles anyway.

## Verify
Dev server: `cd app && npm run dev` (http://localhost:5173). Add `app/scripts/verify-v12.mjs`
in the style of `verify-v11.mjs` (playwright; `window.paperSim` exposes the store). Drive
the dialog with the test image and scripted corner points for the top-left carton, then
assert: doc is gable, dims are sane, `material.overlayImage` is set, the front-body region of
the composed canvas is NOT the background black, and the PDF is one page. Also save a
screenshot of the folded 3D carton to `scripts/shots/`. Run `npx tsc --noEmit` too.
Then the human prints it and folds it. That's the real test.

## Done =
Screen recording: Pinterest image → 8 clicks → textured 3D carton folds up → PDF.
Plus one physically printed + folded carton next to the source image.
Commit when verified; add a short progress-log entry at the top of STATE.md's log.
