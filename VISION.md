# Paper Sim — Vision Onesheet

> The product-direction companion to `STATE.md` (which tracks engineering state).
> Update when the direction changes, not on every feature. Last updated 2026-07-11.

## The pitch

**Turn a standard home printer into a 3D printer — by folding.**
Design real packaging in the browser, watch it fold in 3D, print it true-scale on
ordinary 8.5×11 paper, cut, fold, and hold the real thing. What Roblox does for
virtual worlds, Paper Sim does for *physical* objects: kids (and adults) get the
actual experience of a graphic/industrial designer — dielines, mockups, 3D files —
with a manufacturing loop that costs one sheet of printer paper.

## The wedge: sleeves

A sleeve is a phone case for a drink. An open-ended printed band that slips over a
standard product — a 12 oz can, a 200 ml juice box — and re-skins it:
"Unicorn Sweat" over Diet Coke, "Boys Tears" over 2% milk. It's the perfect first
product because it is:

- **Forgiving** — no waterproofing, no food contact, no closures; the real
  container does the containing. A first fold that can't fail.
- **Expressive** — worn in public like a phone case; inherently shareable.
- **One sheet, one glue seam** — printable on Letter at true scale today.
- **A gateway** — the person who prints one sleeve wants to design one next.

Shipping today: **File → New — Juice box sleeve** (fits a 200 ml brick) and
**New — Can sleeve (12 oz)**. Print true-scale, fold, glue, slide on.

## Product pillars (what we never compromise)

1. **The preview never lies.** UVs are locked to the dieline; the 3D mockup, the
   pattern editor, and the printed sheet are the same data. No "fix it in UVs."
2. **Letter paper first.** No plotter, no Illustrator, no A4 confusion. If it
   can't come out of a home printer at 100% scale, it isn't done. (Multi-sheet
   tiling covers big builds; A4 becomes a setting later, not a default.)
3. **Foldability is guaranteed by construction.** Geometry comes from parametric
   builders or validated imports — never from "an image that looks right."
4. **Free designs, paid materials.** The Cards Against Humanity model: the files
   are free and remixable; the business is what you fold them out of — paper
   packs, laminate sleeve blanks (waterproof, velcro closure), sticker sheets.

## The product ladder

| Rung | Products | Needs |
|------|----------|-------|
| **Now** | Can + juice-box sleeves, milk cartons, tuck boxes, can labels | ✅ shipping |
| **Next** | Sleeve design kit (kid-proof: pick template → drop art → print) | overlay UX polish, per-panel art placement |
| **Then** | Cup carriers, cookie sleeves, egg cartons | SVG dieline import, fan folds, more archetypes |
| **Later** | Tiny vending machines, multi-part builds | multi-sheet projects, tabs/slots, assembly steps |
| **Someday** | Custom laminate/velcro sleeve blanks as a physical product line | materials sourcing, real-world testing |

## The format reality (and the accessibility answer)

Where dielines actually live today:

- **Pinterest jpg/png** — pretty pictures of dielines. ✅ Handled: the
  *Import dieline image* wizard measures the drawing, rebuilds the carton at its
  proportions, and registers the artwork. More archetypes over time.
- **SVG** — the one open vector format we can fully own in the browser.
  🔜 Next build round: import with the industry-ish color convention
  (black = cut, red = crease, yellow = soft/curved fold fan).
- **EPS / AI** (Vecteezy, Freepik, professional dieline libraries) — locked
  behind Illustrator. We do **not** write an EPS parser; the near-term answer is
  a documented one-step conversion (Inkscape or `ps2pdf`/Ghostscript → SVG →
  import), and later possibly a hosted convert-on-upload step. Vector-PDF import
  is a plausible middle ground since we already write PDFs.
- **CFF2/DXF** (real packaging CAM) — out of scope until someone asks.

The accessibility bet: kids shouldn't need to know any of this. Templates and the
image wizard cover the first year; SVG import covers the power users who grow out
of them.

## Paperton (parked, on purpose)

The eventual social layer: a gallery where creations are shared as printable
files + photos of real folds, remixed with lineage ("this sleeve is a remix of
that one"), voted on, maybe tipped. Format inspiration is TikTok/Roblox UGC;
we are **not** competing with them — the differentiator is that every post is a
real object you can print. Digital currency / "become a gazillionaire" ideas stay
parked until there's a community worth an economy. **Prerequisite work that IS
worth doing early:** the `.fold` bundle already carries full history — add a
remix-lineage field and a "share bundle" export so the social layer has a native
file format waiting for it.

## Anti-goals

- Not a physics/cloth sim. Not competing with Roblox/Instagram/TikTok.
- No crypto/currency until there's a community.
- No generative-AI dieline geometry — image models make plausible-looking,
  unfoldable dielines. (AI belongs in artwork synthesis and archetype
  classification, not geometry.)
- Nothing that makes the preview lie about the printout.

## Open questions

- **Laminate sleeve blanks**: material, closure (velcro vs tuck-tab), sizes to
  standardize on (12 oz can + 200 ml brick first?). Needs physical prototyping.
- **Trademark/parody**: personal-use parody sleeves are fine; a future
  marketplace needs moderation rules before launch.
- **Name**: "Paperton" for the platform; does the tool stay "Paper Sim"?
- **Kid-proof mode**: how much of the Maya-style editor gets hidden behind a
  "simple mode" toggle?

## Where engineering is now → what's next

Everything shipped is tracked in `STATE.md`. The current build order:

1. ✅ Trustworthy transforms (edge-ring reshape fix)
2. ✅ True-scale printing on US Letter (1 unit = 1 cm, calibration bar, tiling)
3. ✅ Image → dieline wizard (raster dieline → matched template + registered art),
   now **fit-the-grid**: crop/rotate a Pinterest pin, pick the box archetype, drag its
   fold grid onto the picture, print one true-scale Letter page. **How "any dieline"
   grows: the archetype registry** (`app/src/model/archetypes.ts`). Each box type is
   one module entry (parametric builder + fit guides + guides→params), and the wizard
   never changes. Today: tuck-end box and gable carton. Next in line: egg carton, pillow
   box, cup carrier, hexagon box, mini vending machine. Until one exists, the
   trace-anything path (trace the picture, then "Use backdrop as artwork") prints any
   shape.
4. ✅ Sleeve templates (can + juice box)
5. 🔜 **Physical validation loop** — print a sleeve and a carton, fold them,
   feed what's wrong back into the templates (clearances, line weights, glue
   tabs, paper-weight notes on the instruction sheet)
6. 🔜 **SVG dieline import + fan folds** (rebuild the PackCAD curved box, then
   cup carriers / cookie sleeves)
7. Then: sleeve design kit UX, more image archetypes, share bundles with remix
   lineage, model library, cozy UI pass.
