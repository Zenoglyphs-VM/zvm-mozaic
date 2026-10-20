// Pictures from outside: a file, a drop, or the clipboard.
//
// An image becomes either a stamp, which follows the pointer until a click
// drops its pixels into the draft, or a guide, a see-through layer pinned over
// the canvas to trace by hand, the way r/place's communities worked from
// templates. Neither touches the chain; both are free until the draft is sent.

import {reactive, shallowRef} from 'vue'

export interface Picture {
  name: string
  /** The image at its placed size, one canvas pixel per pixel. */
  canvas: HTMLCanvasElement
  w: number
  h: number
}

/** The stamp in hand, when there is one. */
export const stamp = shallowRef<Picture | null>(null)

/** The guide pinned over the canvas. */
export const guide = reactive({
  picture: null as Picture | null,
  x: 0,
  y: 0,
  opacity: 0.45,
  visible: true,
})

/** An image ready to draw at any size. An SVG stays a vector until it is drawn. */
export interface Decoded {
  source: CanvasImageSource
  width: number
  height: number
  vector: boolean
}

/**
 * Extensions the browser can show, for files the OS hands over with no type.
 * Windows often gives an .ico, and sometimes a .webp or .avif, as "".
 */
const IMAGE_EXT = /\.(png|apng|jpe?g|jfif|pjpeg|pjp|gif|webp|avif|bmp|ico|cur|svg)$/i

/** Whether a file looks like an image the browser can read, by type or by name. */
export function isImage(f: {type: string; name?: string}): boolean {
  return f.type.startsWith('image/') || IMAGE_EXT.test(f.name ?? '')
}

/**
 * Decodes any image the browser can show: PNG, JPEG, GIF and WebP (their first
 * frame when animated), AVIF, BMP, favicons (.ico, .cur) and SVG.
 *
 * Through an <img>, not createImageBitmap: that reads most bitmaps but refuses
 * SVG outright, and is uneven on .ico. An <img> decodes whatever the page could
 * show, which is the promise worth making here.
 *
 * An SVG with no width and height of its own has no natural size in some
 * browsers, so its size is read from its viewBox. It is kept as a vector and
 * drawn at the width chosen, so it comes out sharp rather than enlarged.
 */
export async function decode(file: File | Blob): Promise<Decoded> {
  const name = (file as File).name ?? ''
  if (!isImage({type: file.type, name})) throw new Error('That is not an image.')
  const svg = file.type === 'image/svg+xml' || /\.svg$/i.test(name)
  // An SVG served without its type would not render from a blob URL.
  const blob = svg && file.type !== 'image/svg+xml' ? new Blob([await file.text()], {type: 'image/svg+xml'}) : file
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    try {
      await img.decode()
    } catch {
      throw new Error('This browser could not read that image. PNG, JPEG, GIF, WebP, AVIF, BMP, ICO and SVG all work.')
    }
    let width = img.naturalWidth
    let height = img.naturalHeight
    if (svg) {
      const size = svgSize(await blob.text())
      if (!width || !height) [width, height] = size ?? [512, 512]
      // Vectors are drawn at the chosen size; start them at a size worth drawing at.
      const k = Math.max(1, 256 / Math.max(width, height))
      width = Math.round(width * k)
      height = Math.round(height * k)
    }
    if (!width || !height) throw new Error('That image has no size to read.')
    // A bitmap outlives its URL; an SVG's <img> needs the URL while it is drawn.
    if (svg) return {source: img, width, height, vector: true}
    return {source: await createImageBitmap(img), width, height, vector: false}
  } finally {
    // Kept for an SVG, which is redrawn from it at every width.
    const f = file as Blob
    if (!svg || f === blob) setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}

/** An SVG's width and height from its attributes, else from its viewBox. */
function svgSize(text: string): [number, number] | null {
  const root = text.match(/<svg\b[^>]*>/i)?.[0] ?? ''
  const num = (attr: string) => {
    const m = root.match(new RegExp(`\\b${attr}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, 'i'))
    return m ? Number(m[1]) : NaN
  }
  const w = num('width')
  const h = num('height')
  if (w > 0 && h > 0) return [w, h]
  const vb = root.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i)
  if (vb) return [Number(vb[1]), Number(vb[2])]
  return null
}

/**
 * Scales an image to `width` canvas pixels, keeping its shape. Smoothing is
 * off when enlarging, so pixel art stays crisp, and on when shrinking, so a
 * photo averages rather than aliases.
 */
export function scaled(image: Decoded, width: number, name: string): Picture {
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round((image.height * w) / image.width))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', {willReadFrequently: true})!
  // A vector is rasterised fresh at this size, so smoothing is its own
  // antialiasing; a bitmap is smoothed only when it is being shrunk.
  ctx.imageSmoothingEnabled = image.vector || w < image.width
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image.source, 0, 0, w, h)
  return {name, canvas, w, h}
}

/** The picture's pixels with at least `alpha` opacity (0..255), relative to its top left. */
export function pixelsOf(p: Picture, alpha = 128): {x: number; y: number; rgb: number}[] {
  const d = p.canvas.getContext('2d', {willReadFrequently: true})!.getImageData(0, 0, p.w, p.h).data
  const out: {x: number; y: number; rgb: number}[] = []
  for (let y = 0; y < p.h; y++)
    for (let x = 0; x < p.w; x++) {
      const o = (y * p.w + x) * 4
      if (d[o + 3] < alpha) continue
      out.push({x, y, rgb: (d[o] << 16) | (d[o + 1] << 8) | d[o + 2]})
    }
  return out
}

/** An image on the clipboard, when a paste carries one. */
export function imageFromPaste(e: ClipboardEvent): File | null {
  for (const item of e.clipboardData?.items ?? []) {
    if (item.kind !== 'file') continue
    const f = item.getAsFile()
    if (f && isImage(f)) return f
  }
  return null
}
