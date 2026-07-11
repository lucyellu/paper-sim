// Minimal PDF writer (PDF 1.4), dependency-free: pages, Helvetica text,
// stroked vector lines with dash patterns, and embedded JPEG images
// (DCTDecode passthrough — no re-encoding). Enough for the dieline and
// instruction-sheet exports.

interface PageData {
  w: number
  h: number
  ops: string[]
}

interface JpegImage {
  bytes: Uint8Array
  w: number
  h: number
}

export type RGB = [number, number, number]

export class Pdf {
  private pages: PageData[] = []
  private images: JpegImage[] = []

  private page(): PageData {
    if (this.pages.length === 0) throw new Error('addPage first')
    return this.pages[this.pages.length - 1]
  }

  /** Start a new page (points; default A4 portrait). Origin is bottom-left. */
  addPage(w = 595, h = 842): void {
    this.pages.push({ w, h, ops: [] })
  }

  line(x1: number, y1: number, x2: number, y2: number, width: number, color: RGB, dash?: number[]): void {
    const d = dash && dash.length > 0 ? `[${dash.map(n2).join(' ')}] 0 d` : '[] 0 d'
    this.page().ops.push(
      `${color.map(n2).join(' ')} RG ${n2(width)} w 1 J ${d} ${n2(x1)} ${n2(y1)} m ${n2(x2)} ${n2(y2)} l S`,
    )
  }

  text(x: number, y: number, size: number, str: string, opts?: { bold?: boolean; color?: RGB }): void {
    const color: RGB = opts?.color ?? [0, 0, 0]
    const font = opts?.bold ? '/F2' : '/F1'
    this.page().ops.push(
      `BT ${color.map(n2).join(' ')} rg ${font} ${n2(size)} Tf ${n2(x)} ${n2(y)} Td (${escapeText(str)}) Tj ET`,
    )
  }

  /** Rough Helvetica string width in points (avg glyph ≈ 0.5 em). */
  textWidth(str: string, size: number): number {
    return str.length * size * 0.5
  }

  /** Draw a JPEG (raw bytes + pixel size) into the rect x,y,w,h. */
  imageJpeg(bytes: Uint8Array, pxW: number, pxH: number, x: number, y: number, w: number, h: number): void {
    this.images.push({ bytes, w: pxW, h: pxH })
    const name = `/Im${this.images.length - 1}`
    this.page().ops.push(`q ${n2(w)} 0 0 ${n2(h)} ${n2(x)} ${n2(y)} cm ${name} Do Q`)
  }

  save(): Blob {
    // Objects: 1 catalog, 2 pages tree, 3 F1, 4 F2, then one XObject per
    // image, then per page: page object + its content stream.
    const chunks: Uint8Array[] = []
    const offsets: number[] = []
    let position = 0
    const push = (bytes: Uint8Array) => {
      chunks.push(bytes)
      position += bytes.length
    }
    const pushStr = (s: string) => push(latin1(s))
    const beginObj = (id: number) => {
      offsets[id] = position
      pushStr(`${id} 0 obj\n`)
    }

    const nImg = this.images.length
    const imgObjAt = 5 // first image object id
    const pageObjAt = imgObjAt + nImg
    const totalObjs = pageObjAt + this.pages.length * 2 - 1

    const xobjEntries = this.images.map((_, i) => `/Im${i} ${imgObjAt + i} 0 R`).join(' ')
    const resources = `<< /Font << /F1 3 0 R /F2 4 0 R >>${nImg > 0 ? ` /XObject << ${xobjEntries} >>` : ''} >>`
    const kids = this.pages.map((_, i) => `${pageObjAt + i * 2} 0 R`).join(' ')

    pushStr('%PDF-1.4\n%âãÏÓ\n')
    beginObj(1)
    pushStr('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
    beginObj(2)
    pushStr(`<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>\nendobj\n`)
    beginObj(3)
    pushStr(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n',
    )
    beginObj(4)
    pushStr(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n',
    )
    this.images.forEach((img, i) => {
      beginObj(imgObjAt + i)
      pushStr(
        `<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`,
      )
      push(img.bytes)
      pushStr('\nendstream\nendobj\n')
    })
    this.pages.forEach((p, i) => {
      const pageId = pageObjAt + i * 2
      const contentId = pageId + 1
      beginObj(pageId)
      pushStr(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n2(p.w)} ${n2(p.h)}] /Resources ${resources} /Contents ${contentId} 0 R >>\nendobj\n`,
      )
      const content = latin1(p.ops.join('\n'))
      beginObj(contentId)
      pushStr(`<< /Length ${content.length} >>\nstream\n`)
      push(content)
      pushStr('\nendstream\nendobj\n')
    })

    const xrefAt = position
    pushStr(`xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`)
    for (let id = 1; id <= totalObjs; id++) {
      pushStr(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`)
    }
    pushStr(
      `trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
    )

    return new Blob(chunks as BlobPart[], { type: 'application/pdf' })
  }
}

function n2(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

/** Encode a string as latin1 bytes (stream lengths must be byte-exact). */
function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

/** Map to WinAnsi-safe chars and escape PDF string delimiters. */
function escapeText(s: string): string {
  const MAP: Record<string, string> = {
    '—': '\x97', // em dash
    '–': '\x96', // en dash
    '‘': '\x91',
    '’': '\x92',
    '“': '\x93',
    '”': '\x94',
    '…': '\x85', // ellipsis
    '·': '\xb7',
  }
  let out = ''
  for (const ch of s) {
    const mapped = MAP[ch] ?? ch
    out += mapped.charCodeAt(0) <= 255 ? mapped : '?'
  }
  return out.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}
