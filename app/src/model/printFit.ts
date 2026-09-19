// Does a flat sheet print on ONE US Letter page at true scale? Mirrors
// dielinePDFTrueScale's single-page layout (ui/exports.ts): 24 pt margins, a
// 26 pt footer, and 0.25 cm padding around the sheet.

const CM = 72 / 2.54

/** Largest sheet (cm) that fits one landscape / portrait Letter page. */
export const LETTER_LANDSCAPE = { w: (792 - 48) / CM - 0.5, h: (612 - 48 - 26) / CM - 0.5 }
export const LETTER_PORTRAIT = { w: (612 - 48) / CM - 0.5, h: (792 - 48 - 26) / CM - 0.5 }

/** True when a w × h cm sheet fits one Letter page in either orientation (with `slack` cm to spare). */
export function fitsOneLetterPage(w: number, h: number, slack = 0): boolean {
  const fits = (p: { w: number; h: number }) => w <= p.w - slack && h <= p.h - slack
  return fits(LETTER_LANDSCAPE) || fits(LETTER_PORTRAIT)
}
